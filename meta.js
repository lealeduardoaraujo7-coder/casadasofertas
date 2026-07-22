/**
 * API de Conversões do Meta (server-side).
 *
 * Por que existe: no fluxo Pix, o cliente sai do site para pagar no app do
 * banco e muitas vezes não volta. O pixel do navegador não dispara e a venda
 * some do Meta. Aqui o próprio servidor avisa o Meta quando o pagamento é
 * confirmado, então a conversão é registrada mesmo com o navegador fechado.
 *
 * O evento vai com event_id = número do pedido, o mesmo que o pixel usa. Se os
 * dois chegarem, o Meta entende que é a mesma venda e não conta duas vezes.
 *
 * Variáveis necessárias no .env:
 *   META_PIXEL_ID   — mesmo ID usado no site
 *   META_CAPI_TOKEN — token de acesso gerado no Gerenciador de Eventos
 */

const crypto = require('crypto');

const PIXEL_ID = process.env.META_PIXEL_ID || '';
const TOKEN = process.env.META_CAPI_TOKEN || '';
const VERSAO = 'v21.0';

const ativo = () => !!(PIXEL_ID && TOKEN);

/** O Meta exige os dados pessoais em SHA-256, nunca em texto puro. */
function hash(valor) {
  if (!valor) return undefined;
  return crypto.createHash('sha256').update(String(valor).trim().toLowerCase()).digest('hex');
}

/** Telefone precisa ir com código do país e só dígitos. */
function telefoneE164(tel) {
  const so = String(tel || '').replace(/\D/g, '');
  if (!so) return undefined;
  return hash(so.startsWith('55') ? so : `55${so}`);
}

/**
 * Envia o evento de compra para o Meta.
 * Nunca lança erro: se falhar, apenas registra no log — uma falha de
 * rastreamento não pode derrubar a confirmação de um pedido.
 */
async function enviarCompra(pedido) {
  if (!ativo()) return;

  const c = pedido.cliente || {};
  const partes = String(c.nome || '').trim().split(/\s+/);

  const evento = {
    event_name: 'Purchase',
    event_time: Math.floor(Date.now() / 1000),
    event_id: pedido.pedidoId, // deduplica com o pixel do navegador
    action_source: 'website',
    ...(process.env.PUBLIC_URL ? { event_source_url: `${process.env.PUBLIC_URL}/checkout.html` } : {}),
    user_data: {
      em: hash(c.email),
      ph: telefoneE164(c.telefone),
      fn: hash(partes[0]),
      ln: hash(partes.length > 1 ? partes[partes.length - 1] : ''),
      country: hash('br'),
      ...(c.endereco?.cidade ? { ct: hash(c.endereco.cidade.replace(/\s/g, '')) } : {}),
      ...(c.endereco?.uf ? { st: hash(c.endereco.uf) } : {}),
      ...(c.endereco?.cep ? { zp: hash(String(c.endereco.cep).replace(/\D/g, '')) } : {}),
    },
    custom_data: {
      currency: 'BRL',
      value: pedido.valor,
      content_ids: ['kit-halteres-6em1'],
      content_name: 'Kit Halteres Ajustavel 6 em 1',
      content_type: 'product',
      num_items: 1,
    },
  };

  try {
    const resp = await fetch(`https://graph.facebook.com/${VERSAO}/${PIXEL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [evento], access_token: TOKEN }),
    });
    const texto = await resp.text();
    if (!resp.ok) console.error('[meta capi] falhou:', resp.status, texto);
    else console.log(`[meta capi] Purchase enviado — pedido ${pedido.pedidoId}`);
  } catch (e) {
    console.error('[meta capi] erro de rede:', e.message);
  }
}

module.exports = { enviarCompra, ativo };
