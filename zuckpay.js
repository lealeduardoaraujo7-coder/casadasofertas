/**
 * Integração com a ZuckPay — https://www.zuckpay.com.br
 * Conferido com a documentação oficial da API (v3).
 *
 * Autenticação: HTTP Basic com Client ID e Client Secret.
 *               Authorization: Basic base64(client_id:client_secret)
 * URL base:     https://www.zuckpay.com.br/conta
 *               ATENÇÃO: sempre com "www". Sem o www o CDN redireciona e
 *               transforma o POST em GET, devolvendo 405.
 * Criar Pix:    POST /v3/pix/qrcode
 * Cartão (BR):  POST /v3/card/charge  (card_raw, até 12x)
 * Consultar:    GET  /v3/pix/status?transactionId=...
 *
 * ATENÇÃO ao valor: a ZuckPay trabalha em REAIS (49.90 = R$ 49,90),
 * não em centavos.
 *
 * Sem credenciais no .env o sistema roda em MODO SIMULADO, para testar o
 * visual do checkout sem cobrar ninguém.
 */

const crypto = require('crypto');

const BASE = (process.env.ZUCKPAY_BASE_URL || 'https://www.zuckpay.com.br/conta').replace(/\/$/, '');
const PIX_PATH = process.env.ZUCKPAY_PIX_PATH || '/v3/pix/qrcode';
const STATUS_PATH = process.env.ZUCKPAY_STATUS_PATH || '/v3/pix/status';
const CARD_PATH = process.env.ZUCKPAY_CARD_PATH || '/v3/card/charge';
const CLIENT_ID = process.env.ZUCKPAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ZUCKPAY_CLIENT_SECRET || '';
// O segredo do webhook é gerado à parte (Credenciais API > Webhook Secret) e
// NÃO é o mesmo que o Client Secret. Sem ele a ZuckPay envia o postback sem
// o cabeçalho de assinatura.
const WEBHOOK_SECRET = process.env.ZUCKPAY_WEBHOOK_SECRET || '';

const modoSimulado = () => !CLIENT_ID || !CLIENT_SECRET;
/** Só dá para validar assinatura se o Webhook Secret estiver configurado. */
const assinaturaConfigurada = () => !!WEBHOOK_SECRET;

/** Campos de rastreio que a ZuckPay aceita no corpo e devolve no webhook. */
const CAMPOS_TRACKING = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'src', 'sck', 'fbclid', 'fbc', 'fbp',
  'gclid', 'wbraid', 'gbraid', 'ttclid', 'kclid', 'click_id',
];

/** Filtra as UTMs vindas do checkout, mantendo só o que a API reconhece. */
function tracking(utms) {
  const saida = {};
  for (const campo of CAMPOS_TRACKING) {
    const valor = utms?.[campo] ?? (campo === 'click_id' ? utms?.clickid : undefined);
    if (valor) saida[campo] = String(valor);
  }
  return saida;
}

function headers() {
  const cred = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Basic ${cred}`,
  };
}

/** Status de transação que significam "o dinheiro entrou". */
function statusPago(status) {
  return String(status || '').toUpperCase() === 'PAID';
}

async function chamar(url, opcoes) {
  const resp = await fetch(url, opcoes);
  const texto = await resp.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = { raw: texto }; }
  return { ok: resp.ok, status: resp.status, texto, dados };
}

/**
 * Cria uma cobrança Pix.
 * @returns {{ transacaoId, pixCopiaECola, qrCodeImagem, checkoutUrl, simulado }}
 */
async function criarPix({ valor, descricao, cliente, referencia, callbackUrl, utms }) {
  if (modoSimulado()) {
    const fake = `00020126SIMULADO-${referencia}-${Date.now()}5204000053039865802BR6009SAO PAULO62070503***6304ABCD`;
    return { transacaoId: `sim_${referencia}`, pixCopiaECola: fake, qrCodeImagem: null, checkoutUrl: null, simulado: true };
  }

  const corpo = {
    nome: cliente.nome,
    cpf: String(cliente.cpf || '').replace(/\D/g, ''), // a API quer só números
    email: cliente.email,
    telefone: cliente.telefone,
    valor, // em REAIS
    descricao,
    // Idempotência: repetir a chamada com o mesmo id devolve o mesmo QR Code
    // pendente, em vez de gerar uma segunda cobrança.
    external_id_client: referencia,
    ...(callbackUrl ? { urlnoty: callbackUrl } : {}),
    ...tracking(utms),
  };

  const r = await chamar(BASE + PIX_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(corpo) });

  if (!r.ok) {
    console.error('[ZuckPay] erro ao criar Pix:', r.status, r.texto);
    const msg = r.dados?.message || r.dados?.error || 'Não foi possível gerar o Pix agora.';
    throw new Error(msg);
  }

  const d = r.dados || {};
  const code = d.qrcode || d.pix_code;
  if (!code) {
    console.error('[ZuckPay] resposta sem código Pix:', r.texto);
    throw new Error('A ZuckPay respondeu, mas não veio o código Pix.');
  }

  return {
    transacaoId: d.transactionId || d.id,
    pixCopiaECola: code,
    qrCodeImagem: d.qrcode_image || null,
    checkoutUrl: d.checkout_url || null,
    simulado: false,
  };
}

/**
 * Cobra no cartão de crédito nacional (BRL) via POST /v3/card/charge.
 * O fluxo nacional manda `card_raw` direto — não passa por Stripe.js.
 *
 * O site hoje vende só por Pix; esta função existe para o caso de o cartão
 * ser reativado no checkout. O número do cartão nunca é gravado em disco.
 *
 * @returns {{ transacaoId, aprovado, motivo, simulado }}
 */
async function cobrarCartao({ valor, descricao, cliente, referencia, callbackUrl, utms, cartao }) {
  if (modoSimulado()) {
    // Regra de teste: cartão terminado em 0000 é recusado, o resto aprova.
    const aprovado = !String(cartao?.numero || '').replace(/\D/g, '').endsWith('0000');
    return {
      transacaoId: `sim_${referencia}`,
      aprovado,
      motivo: aprovado ? null : 'Cartão recusado pelo emissor (simulado).',
      simulado: true,
    };
  }

  const [mes, ano] = String(cartao.validade || '').split('/').map((p) => p.trim());
  const corpo = {
    nome: cartao.nome || cliente.nome,
    email: cliente.email,
    cpf: String(cliente.cpf || '').replace(/\D/g, ''),
    telefone: cliente.telefone,
    valor, // em REAIS
    currency: 'BRL',
    installments: Number(cartao.parcelas || 1),
    descricao,
    external_id_client: referencia,
    card_raw: {
      number: String(cartao.numero || '').replace(/\D/g, ''),
      holder_name: cartao.nome,
      exp_month: mes,
      // A API aceita o ano com 4 dígitos; o formulário manda 2.
      exp_year: ano && ano.length === 2 ? `20${ano}` : ano,
      cvv: cartao.cvv,
    },
    ...(callbackUrl ? { urlnoty: callbackUrl } : {}),
    ...tracking(utms),
  };

  const r = await chamar(BASE + CARD_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(corpo) });

  if (!r.ok) {
    console.error('[ZuckPay] erro ao cobrar cartão:', r.status, r.texto);
    const msg = r.dados?.failureMessage || r.dados?.message || r.dados?.error || 'Não foi possível processar o cartão.';
    return { transacaoId: r.dados?.transactionId || null, aprovado: false, motivo: msg, simulado: false };
  }

  const d = r.dados || {};
  // PENDING e PENDING_3DS não são aprovação: a confirmação chega no webhook.
  const aprovado = d.isPaid === true || statusPago(d.status);

  return {
    transacaoId: d.transactionId || d.id,
    aprovado,
    motivo: aprovado ? null : (d.failureMessage || 'Pagamento não aprovado. Tente o Pix.'),
    simulado: false,
  };
}

/**
 * Consulta a transação. A confirmação boa vem pelo urlnoty (webhook); quem
 * chama aqui controla o intervalo de polling — ver o limite em server.js.
 */
async function consultarPago(transacaoId) {
  if (modoSimulado()) return false;

  const url = `${BASE}${STATUS_PATH}?transactionId=${encodeURIComponent(transacaoId)}`;
  const r = await chamar(url, { headers: headers() });
  if (!r.ok) {
    console.error('[ZuckPay] erro ao consultar transação:', r.status, r.texto);
    return false;
  }
  return statusPago(r.dados.status);
}

/**
 * Confere a assinatura de um webhook da ZuckPay.
 *
 * Um único cabeçalho carrega tudo:  X-ZuckPay-Signature: t=<ts>,v1=<hex>
 * onde v1 = HMAC-SHA256("<ts>.<corpo_cru>", WEBHOOK_SECRET).
 *
 * O segredo é o Webhook Secret (Credenciais API), NÃO o Client Secret.
 * Se ele não estiver gerado, a ZuckPay manda o postback sem esse cabeçalho —
 * quem chama decide o que fazer nesse caso (ver server.js).
 *
 * @param {Buffer|string} rawBody corpo cru da requisição (não o JSON já parseado)
 * @param {string} signature conteúdo do cabeçalho X-ZuckPay-Signature
 */
function verificarAssinatura(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature || rawBody == null) return false;

  const t = /(?:^|,)\s*t=(\d+)/.exec(String(signature))?.[1];
  const v1 = /(?:^|,)\s*v1=([a-f0-9]+)/i.exec(String(signature))?.[1];
  if (!t || !v1) return false;

  // Rejeita timestamps com mais de 5 minutos (proteção contra replay).
  const agora = Math.floor(Date.now() / 1000);
  if (Math.abs(agora - Number(t)) > 300) return false;

  const esperado = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(`${t}.`)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(v1.toLowerCase(), 'hex');
  const b = Buffer.from(esperado, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  criarPix, cobrarCartao, consultarPago, statusPago,
  modoSimulado, assinaturaConfigurada, verificarAssinatura,
};
