/**
 * Integração com a AmploPay — PIX e Cartão de Crédito.
 *
 * >>> ESTE É O ÚNICO ARQUIVO QUE PRECISA MUDAR QUANDO A DOC OFICIAL FOR CONFERIDA. <<<
 *
 * A doc fica em https://app.amplopay.com/docs e exige login (não abre de fora),
 * então os nomes de rota/campo abaixo seguem o padrão desses gateways. Se algo
 * divergir, mude só aqui e no .env — o site inteiro continua funcionando.
 *
 * Sem credenciais no .env o sistema roda em MODO SIMULADO, para testar o visual
 * do checkout sem cobrar ninguém.
 */

const BASE = (process.env.AMPLOPAY_BASE_URL || 'https://api.amplopay.com').replace(/\/$/, '');
const CREATE_PATH = process.env.AMPLOPAY_CREATE_PATH || '/v1/transactions';
const STATUS_PATH = process.env.AMPLOPAY_STATUS_PATH || '/v1/transactions/{id}';
const CLIENT_ID = process.env.AMPLOPAY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AMPLOPAY_CLIENT_SECRET || '';

const modoSimulado = () => !CLIENT_ID || !CLIENT_SECRET;

function headers() {
  const modo = (process.env.AMPLOPAY_AUTH_MODE || 'basic').toLowerCase();
  const auth = modo === 'bearer'
    ? `Bearer ${CLIENT_SECRET}`
    : `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  return { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: auth };
}

/** Procura na resposta o primeiro valor entre as chaves informadas. */
function buscar(obj, chaves) {
  if (!obj || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj)) {
    if (chaves.includes(k) && typeof v === 'string' && v.length > 5) return v;
    if (v && typeof v === 'object') {
      const achou = buscar(v, chaves);
      if (achou) return achou;
    }
  }
  return null;
}

function statusPago(status) {
  return ['PAID', 'APPROVED', 'COMPLETED', 'CONFIRMED', 'PAGO', 'AUTHORIZED'].includes(
    String(status || '').toUpperCase()
  );
}

async function chamar(caminho, opcoes) {
  const resp = await fetch(BASE + caminho, opcoes);
  const texto = await resp.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = { raw: texto }; }
  return { ok: resp.ok, status: resp.status, texto, dados };
}

function corpoBase({ valorCentavos, descricao, cliente, referencia, webhookUrl }) {
  return {
    amount: valorCentavos,
    externalRef: referencia,
    description: descricao,
    customer: {
      name: cliente.nome,
      email: cliente.email,
      document: cliente.cpf,
      phone: cliente.telefone,
      ...(cliente.endereco ? {
        address: {
          zipCode: cliente.endereco.cep,
          street: cliente.endereco.rua,
          number: cliente.endereco.numero,
          city: cliente.endereco.cidade,
          state: cliente.endereco.uf,
          country: 'BR',
        },
      } : {}),
    },
    items: [{ title: descricao, quantity: 1, unitPrice: valorCentavos }],
    ...(webhookUrl ? { postbackUrl: webhookUrl, webhookUrl } : {}),
  };
}

/**
 * Cria uma cobrança PIX.
 * @returns {{ transacaoId, pixCopiaECola, qrCodeImagem, simulado }}
 */
async function criarPix(dados) {
  if (modoSimulado()) {
    const fake = `00020126SIMULADO-${dados.referencia}-${Date.now()}5204000053039865802BR6009SAO PAULO62070503***6304ABCD`;
    return { transacaoId: `sim_${dados.referencia}`, pixCopiaECola: fake, qrCodeImagem: null, simulado: true };
  }

  const r = await chamar(CREATE_PATH, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...corpoBase(dados), paymentMethod: 'PIX' }),
  });

  if (!r.ok) {
    console.error('[AmploPay] erro ao criar PIX:', r.status, r.texto);
    throw new Error(`AmploPay respondeu ${r.status}. Confira as credenciais e os endpoints no .env.`);
  }

  const copiaECola = buscar(r.dados, ['qrcode', 'qrCode', 'pixCode', 'emv', 'copyPaste', 'payload', 'brCode']);
  if (!copiaECola) {
    console.error('[AmploPay] resposta sem código PIX:', r.texto);
    throw new Error('A AmploPay respondeu, mas não veio o código PIX. Ajuste os nomes dos campos em amplopay.js.');
  }

  return {
    transacaoId: buscar(r.dados, ['id', 'transactionId', 'transaction_id']) || dados.referencia,
    pixCopiaECola: copiaECola,
    qrCodeImagem: buscar(r.dados, ['qrCodeBase64', 'qrCodeImage', 'imageUrl', 'qr_code_base64']),
    simulado: false,
  };
}

/**
 * Cobra no cartão de crédito.
 * @returns {{ transacaoId, aprovado, motivo, simulado }}
 */
async function cobrarCartao(dados) {
  const { cartao } = dados;

  if (modoSimulado()) {
    // Regra só para teste: cartão terminado em 0000 é recusado, o resto aprova.
    const aprovado = !cartao.numero.endsWith('0000');
    return {
      transacaoId: `sim_${dados.referencia}`,
      aprovado,
      motivo: aprovado ? null : 'Pagamento recusado pelo emissor (simulação).',
      simulado: true,
    };
  }

  const r = await chamar(CREATE_PATH, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      ...corpoBase(dados),
      paymentMethod: 'CREDIT_CARD',
      installments: cartao.parcelas,
      card: {
        number: cartao.numero,
        holderName: cartao.titular,
        expirationMonth: String(cartao.mes).padStart(2, '0'),
        expirationYear: String(cartao.ano),
        cvv: cartao.cvv,
      },
    }),
  });

  if (!r.ok) {
    console.error('[AmploPay] erro ao cobrar cartão:', r.status, r.texto);
    throw new Error('Não foi possível processar o cartão. Confira os dados ou tente pagar com PIX.');
  }

  const status = buscar(r.dados, ['status', 'paymentStatus', 'transactionStatus']);
  return {
    transacaoId: buscar(r.dados, ['id', 'transactionId', 'transaction_id']) || dados.referencia,
    aprovado: statusPago(status),
    motivo: statusPago(status) ? null : (buscar(r.dados, ['refuseReason', 'message', 'error']) || 'Pagamento não autorizado pelo emissor.'),
    simulado: false,
  };
}

/** Consulta a transação e devolve true se já estiver paga. */
async function consultarPago(transacaoId) {
  if (modoSimulado()) return false;

  const r = await chamar(STATUS_PATH.replace('{id}', encodeURIComponent(transacaoId)), { headers: headers() });
  if (!r.ok) return false;

  return statusPago(buscar(r.dados, ['status', 'paymentStatus', 'transactionStatus']));
}

module.exports = { criarPix, cobrarCartao, consultarPago, statusPago, modoSimulado };
