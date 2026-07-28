require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  criarPix, cobrarCartao, consultarPago, statusPago,
  modoSimulado, assinaturaConfigurada, verificarAssinatura,
} = require('./zuckpay');
const QRCode = require('qrcode');
const meta = require('./meta');
const utmify = require('./utmify');

const app = express();
const PORT = process.env.PORT || 3000;
const PRECO = Number(process.env.PRODUCT_PRICE || 68.9); // a ZuckPay cobra em REAIS
const QTD_MAXIMA = 5;
const DESCRICAO = 'Kit Halteres Ajustavel 6 em 1';
// Na Vercel o disco do projeto é somente-leitura: só /tmp aceita escrita, e
// esse /tmp é temporário (some quando a função hiberna). Por isso mantemos um
// cache em memória junto — e a confirmação real do pagamento sempre vem da
// consulta à ZuckPay, não do arquivo.
const NA_VERCEL = !!process.env.VERCEL;
const ARQUIVO_PEDIDOS = NA_VERCEL
  ? path.join('/tmp', 'pedidos.json')
  : path.join(__dirname, 'pedidos.json');

let cache = null;

// O `verify` guarda o corpo cru: a assinatura do webhook da ZuckPay é
// calculada sobre os bytes originais, não sobre o JSON já parseado.
app.use(express.json({
  limit: '30mb', // as fotos chegam em base64 no upload
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Imagem em outro formato ----------
   As páginas pedem /img/produto-1.jpg. Se o arquivo salvo for .png ou .webp,
   servimos ele mesmo assim, em vez de devolver 404.                        */
app.get('/img/:arquivo', (req, res, next) => {
  const base = path.parse(req.params.arquivo).name;
  if (!/^[\w-]+$/.test(base)) return next();
  try {
    const achado = fs.readdirSync(path.join(__dirname, 'public', 'img'))
      .find((a) => path.parse(a).name === base);
    if (achado) return res.sendFile(path.join(__dirname, 'public', 'img', achado));
  } catch { /* pasta não existe ainda */ }
  next();
});

/* ---------- Painel de upload de imagens (só na sua máquina) ----------
   Fica disponível apenas rodando local: na Vercel o disco é somente-leitura
   e qualquer arquivo enviado sumiria na próxima requisição. Por isso as
   imagens são gravadas aqui e vão pro site pelo git push.               */
const PASTA_IMG = path.join(__dirname, 'public', 'img');
const NOMES_VALIDOS = /^(produto-[1-7]|review-([1-9]|1[01]))$/;
const EXTENSOES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

function apenasLocal(req, res, next) {
  if (NA_VERCEL) return res.status(403).json({ erro: 'O envio de imagens só funciona rodando o site na sua máquina.' });
  const ip = req.ip || '';
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) {
    return res.status(403).json({ erro: 'Disponível apenas em localhost.' });
  }
  next();
}

app.get('/api/admin/imagens', apenasLocal, (req, res) => {
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(PASTA_IMG)
      .filter((a) => NOMES_VALIDOS.test(path.parse(a).name))
      .map((a) => ({ nome: path.parse(a).name, arquivo: a }));
  } catch { /* pasta ainda não existe */ }
  res.json({ arquivos });
});

app.post('/api/admin/upload', apenasLocal, (req, res) => {
  const { nome, dataUrl } = req.body || {};
  if (!NOMES_VALIDOS.test(nome || '')) return res.status(400).json({ erro: 'Nome de imagem não reconhecido.' });

  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return res.status(400).json({ erro: 'Arquivo inválido.' });

  const ext = EXTENSOES[m[1]];
  if (!ext) return res.status(400).json({ erro: `Formato ${m[1]} não suportado. Use JPG, PNG ou WebP.` });

  fs.mkdirSync(PASTA_IMG, { recursive: true });
  // Apaga versões antigas do mesmo slot para não ficar produto-1.jpg e produto-1.png juntos
  for (const antigo of fs.readdirSync(PASTA_IMG)) {
    if (path.parse(antigo).name === nome) fs.unlinkSync(path.join(PASTA_IMG, antigo));
  }

  const arquivo = nome + ext;
  fs.writeFileSync(path.join(PASTA_IMG, arquivo), Buffer.from(m[2], 'base64'));
  console.log(`[upload] ${arquivo} salvo`);
  res.json({ arquivo, caminho: `/img/${arquivo}` });
});

/* ---------- "Banco de dados" simples ---------- */
function lerPedidos() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(ARQUIVO_PEDIDOS, 'utf8')); } catch { cache = {}; }
  return cache;
}
function salvarPedidos(p) {
  cache = p;
  try {
    fs.writeFileSync(ARQUIVO_PEDIDOS, JSON.stringify(p, null, 2));
  } catch (e) {
    console.error('[aviso] não consegui gravar os pedidos em disco:', e.message);
  }
}
/** Avisa Meta e Utmify da venda, uma única vez por pedido. */
function marcarConversao(pedido) {
  if (pedido.conversaoEnviada) return;
  pedido.conversaoEnviada = true;
  meta.enviarCompra(pedido);              // sem await: não faz o cliente esperar
  utmify.enviarPedido(pedido, 'paid');    // registra a venda confirmada
}

function gerarId() {
  return 'CO' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/* ---------- Cria o pedido (PIX ou cartão) ---------- */
app.post('/api/pedidos', async (req, res) => {
  const c = req.body?.cliente || {};
  const pagamento = req.body?.pagamento || { metodo: 'pix' };

  const faltando = ['nome', 'email', 'cpf', 'telefone'].filter((k) => !c[k]);
  if (faltando.length) {
    return res.status(400).json({ erro: `Dados incompletos: ${faltando.join(', ')}.` });
  }

  // O total é calculado aqui, nunca aceito pronto do cliente.
  const quantidade = Math.floor(Number(req.body?.quantidade) || 1);
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > QTD_MAXIMA) {
    return res.status(400).json({ erro: `Quantidade deve ser entre 1 e ${QTD_MAXIMA}.` });
  }
  const valorTotal = Number((PRECO * quantidade).toFixed(2));
  if (pagamento.metodo === 'cartao' && !pagamento.cartao?.numero) {
    return res.status(400).json({ erro: 'Dados do cartão não recebidos.' });
  }

  const pedidoId = gerarId();
  const base = {
    valor: valorTotal,
    descricao: quantidade > 1 ? `${DESCRICAO} (${quantidade}x)` : DESCRICAO,
    cliente: c,
    referencia: pedidoId,
    callbackUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/api/webhook/zuckpay` : null,
    // A ZuckPay guarda as UTMs/fbc/fbp junto da transação e devolve no webhook.
    utms: req.body?.utms || {},
  };

  // O pedido é gravado sem NENHUM dado de cartão — só os 4 últimos dígitos.
  function gravar(extra) {
    const pedidos = lerPedidos();
    pedidos[pedidoId] = {
      pedidoId,
      cliente: c,
      valor: valorTotal,
      quantidade,
      metodo: pagamento.metodo,
      utms: req.body?.utms || {},
      criadoEm: new Date().toISOString(),
      ...extra,
    };
    salvarPedidos(pedidos);
  }

  try {
    /* ----- Cartão de crédito ----- */
    if (pagamento.metodo === 'cartao') {
      const cartao = pagamento.cartao;
      const r = await cobrarCartao({ ...base, cartao });

      gravar({
        transacaoId: r.transacaoId,
        pago: r.aprovado,
        simulado: r.simulado,
        cartaoFinal: cartao.numero.slice(-4),
        parcelas: cartao.parcelas,
      });

      console.log(`[pedido] ${pedidoId} cartão final ${cartao.numero.slice(-4)} — ${r.aprovado ? 'APROVADO' : 'RECUSADO'}${r.simulado ? ' [SIMULADO]' : ''}`);

      if (!r.aprovado) return res.status(402).json({ erro: r.motivo });
      return res.json({ pedidoId, aprovado: true, simulado: r.simulado });
    }

    /* ----- PIX ----- */
    const pix = await criarPix(base);
    gravar({ transacaoId: pix.transacaoId, pago: false, simulado: pix.simulado });

    // Registra o pedido pendente na Utmify (a confirmação vem depois, no pago).
    utmify.enviarPedido(lerPedidos()[pedidoId], 'waiting_payment');

    console.log(`[pedido] ${pedidoId} PIX criado — ${c.nome} (${c.email})${pix.simulado ? ' [SIMULADO]' : ''}`);

    // Se o gateway não mandar a imagem, desenhamos o QR aqui mesmo. Antes isso
    // apontava para um serviço externo (api.qrserver.com): o cliente esperava
    // ~0,7s de rede olhando um espaço vazio, e o QR sumia se o serviço caísse.
    let qrCodeImagem = pix.qrCodeImagem;
    if (!qrCodeImagem) {
      try {
        qrCodeImagem = await QRCode.toDataURL(pix.pixCopiaECola, { width: 300, margin: 1 });
      } catch (e) {
        // Sem imagem o cliente ainda paga pelo Copia e Cola: não é motivo
        // para derrubar o pedido inteiro.
        console.error('[aviso] não consegui gerar o QR Code:', e.message);
        qrCodeImagem = null;
      }
    }

    res.json({
      pedidoId,
      aprovado: false,
      pixCopiaECola: pix.pixCopiaECola,
      qrCodeImagem,
      simulado: pix.simulado,
    });
  } catch (e) {
    console.error('[erro ao criar pedido]', e.message);
    res.status(502).json({ erro: e.message });
  }
});

/* ---------- Checkout consulta se já foi pago ---------- */
app.get('/api/pedidos/:id/status', async (req, res) => {
  const pedidos = lerPedidos();
  const pedido = pedidos[req.params.id];
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });

  // O checkout pergunta a cada 5s, mas a ZuckPay pede para não fazer polling
  // frequente na API deles (a confirmação boa chega pelo urlnoty). Então
  // consultamos o gateway no máximo uma vez a cada 20 segundos por pedido.
  const INTERVALO_CONSULTA = 20000;
  const agora = Date.now();

  if (!pedido.pago && agora - (pedido.consultadoEm || 0) > INTERVALO_CONSULTA) {
    pedido.consultadoEm = agora;
    try {
      if (await consultarPago(pedido.transacaoId)) {
        pedido.pago = true;
        pedido.pagoEm = new Date().toISOString();
        console.log(`[pago] ${pedido.pedidoId} — ${pedido.cliente.nome}`);
        marcarConversao(pedido);
      }
    } catch (e) {
      console.error('[erro ao consultar status]', e.message);
    }
    salvarPedidos(pedidos);
  }

  res.json({ pago: pedido.pago });
});

/* ---------- Webhook / postback da ZuckPay (urlnoty) ---------- */
app.post('/api/webhook/zuckpay', (req, res) => {
  const corpo = req.body || {};
  console.log('[webhook zuckpay]', JSON.stringify(corpo));

  // A assinatura só existe se houver um Webhook Secret gerado no painel.
  // Com secret configurado, postback sem assinatura válida é recusado.
  if (assinaturaConfigurada()) {
    if (!verificarAssinatura(req.rawBody, req.get('X-ZuckPay-Signature'))) {
      console.error('[webhook zuckpay] assinatura inválida — ignorado');
      return res.sendStatus(401);
    }
  } else if (!modoSimulado()) {
    console.warn('[webhook zuckpay] sem ZUCKPAY_WEBHOOK_SECRET: postback aceito SEM validação.');
  }

  // Formato oficial: { event, platform, transaction: {...} }. O postback do
  // SPEI vem sem o envelope, então aceitamos o corpo direto também.
  const t = corpo.transaction || corpo.data || corpo;
  const status = t.status;
  const ref = t.external_id_client || t.external_id;
  const transacaoId = t.id || t.transactionId;

  const pedidos = lerPedidos();
  const pedido = pedidos[ref] || Object.values(pedidos).find((p) => p.transacaoId === transacaoId);

  if (pedido && statusPago(status)) {
    pedido.pago = true;
    pedido.pagoEm = new Date().toISOString();
    marcarConversao(pedido);
    salvarPedidos(pedidos);
    console.log(`[pago via webhook] ${pedido.pedidoId}`);
  }

  res.sendStatus(200);
});

/* ---------- Só para TESTE: marca um pedido como pago manualmente ---------- */
app.post('/api/pedidos/:id/simular-pagamento', (req, res) => {
  if (!modoSimulado()) return res.status(403).json({ erro: 'Disponível apenas no modo simulado.' });
  const pedidos = lerPedidos();
  const pedido = pedidos[req.params.id];
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  pedido.pago = true;
  salvarPedidos(pedidos);
  res.json({ ok: true });
});

// Na Vercel o app roda como função serverless — quem chama o listen é a plataforma.
if (NA_VERCEL) {
  module.exports = app;
} else app.listen(PORT, () => {
  console.log(`\n  Casa das Ofertas rodando em http://localhost:${PORT}`);
  console.log(`  Produto: R$ ${PRECO.toFixed(2).replace('.', ',')}`);
  if (modoSimulado()) {
    console.log('  ⚠️  MODO SIMULADO — sem credenciais ZuckPay no .env. Os PIX gerados NÃO são reais.\n');
  } else {
    console.log('  ✅ ZuckPay conectada.\n');
  }
});
