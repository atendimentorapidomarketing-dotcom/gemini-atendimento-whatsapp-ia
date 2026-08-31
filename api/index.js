const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

// Inicialização das conexões
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Palavras-chave que forçam a intervenção humana imediata (Hard Rules)
const PALAVRAS_CHAVE_HUMANO = [
  'humano', 'atendente', 'falar com pessoa', 'desconto', 'descontos',
  'negociar', 'reclamação', 'reclamacao', 'gerente', 'ligar', 'telefone'
];

// 1. WEBHOOK DO WHATSAPP - VALIDAÇÃO DA META
app.get('/api/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// 2. RECEBIMENTO DE MENSAGENS DO WHATSAPP
app.post('/api/webhook', async (req, res) => {
  res.sendStatus(200); // Responde imediatamente à Meta para evitar reenvio

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return;

    const telefone = message.from;
    const textoCliente = message.text.body;

    // Buscar ou Criar Cliente no Supabase
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefone', telefone)
      .single();

    if (!cliente) {
      const { data: novoCliente } = await supabase
        .from('clientes')
        .insert([{ telefone }])
        .select()
        .single();
      cliente = novoCliente;
    }

    // Registrar mensagem do cliente no histórico
    await supabase.from('mensagens').insert([
      { cliente_id: cliente.id, remetente: 'cliente', texto: textoCliente }
    ]);

    // Se o atendimento estiver com humano ou encerrado, a IA ignora a resposta automática
    if (cliente.status === 'HUMANO ATENDENDO' || cliente.status === 'ENCERRADO') {
      return;
    }

    // Verificação por Código (Hard Rules de Intervenção)
    const textoMin = textoCliente.toLowerCase();
    const precisaHumano = PALAVRAS_CHAVE_HUMANO.some(palavra => textoMin.includes(palavra));

    if (precisaHumano) {
      await supabase.from('clientes').update({
        status: 'PRECISA DE HUMANO',
        motivo_intervencao: `Solicitação detectada na mensagem: "${textoCliente}"`
      }).eq('id', cliente.id);

      await enviarMensagemWhatsApp(telefone, 'Entendi. Estou encaminhando o seu atendimento para um de nossos especialistas. Aguarde um instante por favor.');
      return;
    }

    // Buscar Regras e Dados da Empresa
    const { data: config } = await supabase.from('configuracoes_empresa').select('*').eq('id', 1).single();

    // Construção do Prompt Enxuto (Economia de Tokens)
    const systemInstruction = `
Você é o assistente virtual da empresa ${config.nome_empresa}.
Serviços oferecidos: ${config.servicos_oferecidos}
Regiões atendidas: ${config.regioes_atendidas}
Horário de atendimento: ${config.horario_atendimento}
Regras de preços: ${config.regras_precos}
Políticas de desconto: ${config.politicas_desconto}

REGRAS RÍGIDAS DE COMPORTAMENTO:
1. Responda de forma curta, natural e amigável em Português do Brasil.
2. NUNCA invente preços, prazos ou serviços não listados.
3. NUNCA ofereça ou aceite conceder descontos.
4. Tente identificar na conversa: Nome do cliente, Serviço procurado, Problema e Bairro.
5. Se não souber a resposta ou se o cliente solicitar negociação, responda exatamente com a tag [INTERVENCAO] no final do texto para acionar o suporte humano.
    `;

    const promptContexto = `Resumo até agora: ${cliente.resumo_conversa || 'Início de conversa'}\nÚltima mensagem do cliente: "${textoCliente}"`;

    // Chamada à API da IA (Gemini 2.5 Flash)
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { role: 'user', parts: [{ text: systemInstruction + '\n\n' + promptContexto }] }
      ]
    });

    let respostaIA = response.text || '';

    // Registrar consumo estimado de tokens
    if (response.usageMetadata) {
      await supabase.from('consumo_tokens').insert([{
        cliente_id: cliente.id,
        tokens_entrada: response.usageMetadata.promptTokenCount,
        tokens_saida: response.usageMetadata.candidatesTokenCount
      }]);
    }

    // Verificar se a IA pediu intervenção
    if (respostaIA.includes('[INTERVENCAO]')) {
      respostaIA = respostaIA.replace('[INTERVENCAO]', '').trim();
      await supabase.from('clientes').update({
        status: 'PRECISA DE HUMANO',
        motivo_intervencao: 'A IA identificou que a situação exige suporte humano.'
      }).eq('id', cliente.id);
    }

    // Registrar e enviar resposta da IA
    if (respostaIA) {
      await supabase.from('mensagens').insert([
        { cliente_id: cliente.id, remetente: 'ia', texto: respostaIA }
      ]);
      await enviarMensagemWhatsApp(telefone, respostaIA);
    }

  } catch (error) {
    console.error('Erro no processamento do Webhook:', error);
  }
});

// 3. API PARA O PAINEL DE ATENDIMENTO
app.get('/api/painel/dados', async (req, res) => {
  const { data: clientes } = await supabase.from('clientes').select('*').order('atualizado_em', { ascending: false });
  const { data: config } = await supabase.from('configuracoes_empresa').select('*').eq('id', 1).single();
  const { data: consumo } = await supabase.from('consumo_tokens').select('tokens_entrada, tokens_saida');

  res.json({ clientes, config, consumo });
});

app.post('/api/painel/acao', async (req, res) => {
  const { clienteId, acao, textoMensagem } = req.body;
  
  const { data: cliente } = await supabase.from('clientes').select('*').eq('id', clienteId).single();

  if (acao === 'assumir') {
    await supabase.from('clientes').update({ status: 'HUMANO ATENDENDO' }).eq('id', clienteId);
  } else if (acao === 'devolver') {
    await supabase.from('clientes').update({ status: 'IA ATENDENDO' }).eq('id', clienteId);
  } else if (acao === 'enviar_mensagem' && textoMensagem) {
    await supabase.from('mensagens').insert([{ cliente_id: clienteId, remetente: 'humano', texto: textoMensagem }]);
    await enviarMensagemWhatsApp(cliente.telefone, textoMensagem);
  }

  res.json({ success: true });
});

// Função Auxiliar para Envio via Meta Cloud API
async function enviarMensagemWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    })
  });
}

module.exports = app;
