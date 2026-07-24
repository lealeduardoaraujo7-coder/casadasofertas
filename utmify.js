/**
 * API de Pedidos da Utmify (server-side).
 *
 * Por que existe: o pixel da Utmify no navegador só registra a venda se o
 * cliente estiver na página. No Pix o pagamento cai depois, com o navegador
 * fechado — então a confirmação precisa sair do servidor. Aqui avisamos a
 * Utmify duas vezes por pedido:
 *   1. quando o Pix é gerado          -> status "waiting_payment"
 *   2. quando o pagamento é confirmado -> status "paid"
 * O mesmo orderId nas duas chamadas faz a Utmify atualizar o pedido existente,
 * em vez de criar dois.
 *
 * Doc: POST https://api.utmify.com.br/api-credentials/orders
 *      Header x-api-token · valores em CENTAVOS · datas em UTC.
 *
 * Variável necessária no .env:
 *   UTMIFY_API_TOKEN — Painel da Utmify > Integrações > API de Credenciais.
 */

const ENDPOINT = process.env.UTMIFY_URL || 'https://api.utmify.com.br/api-credentials/orders';
const TOKEN = process.env.UTMIFY_API_TOKEN || '';

const ativo = () => !!TOKEN;

/** A Utmify quer a data em UTC no formato "YYYY-MM-DD HH:MM:SS". */
function dataUtc(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Só os campos de rastreio que a Utmify reconhece (o resto ela ignora). */
function trackingParameters(utms = {}) {
  const p = {};
  for (const k of ['src', 'sck', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term']) {
    p[k] = utms[k] || null;
  }
  return p;
}

/**
 * Envia (ou atualiza) um pedido na Utmify.
 * Nunca lança erro: uma falha de rastreamento não pode derrubar o pedido.
 * @param {object} pedido  registro salvo em server.js
 * @param {'waiting_payment'|'paid'|'refused'|'refunded'|'chargedback'} status
 */
async function enviarPedido(pedido, status) {
  if (!ativo()) return;

  const c = pedido.cliente || {};
  const centavos = Math.round(Number(pedido.valor || 0) * 100);
  const pago = status === 'paid';

  const corpo = {
    orderId: pedido.pedidoId,
    platform: 'CasaDasOfertas',
    paymentMethod: pedido.metodo === 'cartao' ? 'credit_card' : 'pix',
    status,
    createdAt: dataUtc(pedido.criadoEm),
    approvedDate: pago ? dataUtc(pedido.pagoEm) : null,
    refundedAt: null,
    customer: {
      name: c.nome || null,
      email: c.email || null,
      phone: c.telefone ? String(c.telefone).replace(/\D/g, '') : null,
      document: c.cpf ? String(c.cpf).replace(/\D/g, '') : null,
      country: 'BR',
    },
    products: [{
      id: 'kit-halteres-6em1',
      name: 'Kit Halteres Ajustavel 6 em 1',
      planId: null,
      planName: null,
      quantity: 1,
      priceInCents: centavos,
    }],
    trackingParameters: trackingParameters(pedido.utms),
    commission: {
      totalPriceInCents: centavos,
      gatewayFeeInCents: 0,
      userCommissionInCents: centavos,
      currency: 'BRL',
    },
    // Pedido do modo simulado não polui os relatórios reais da Utmify.
    isTest: !!pedido.simulado,
  };

  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': TOKEN },
      body: JSON.stringify(corpo),
    });
    const texto = await resp.text();
    if (!resp.ok) console.error('[utmify] falhou:', resp.status, texto);
    else console.log(`[utmify] pedido ${pedido.pedidoId} -> ${status}`);
  } catch (e) {
    console.error('[utmify] erro de rede:', e.message);
  }
}

module.exports = { enviarPedido, ativo };
