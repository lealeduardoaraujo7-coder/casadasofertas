require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { criarPix, cobrarCartao, consultarPago, statusPago, modoSimulado } = require('./amplopay');

const app = express();
const PORT = process.env.PORT || 3000;
const PRECO = Number(process.env.PRODUCT_PRICE || 89.9);
const VALOR_CENTAVOS = Math.round(PRECO * 100);
// Na Vercel o disco do projeto é somente-leitura: só /tmp aceita escrita, e
// esse /tmp é temporário (some quando a função hiberna). Por isso mantemos um
// cache em memória junto — e a confirmação real do pagamento sempre vem da
// consulta à AmploPay, não do arquivo.
const NA_VERCEL = !!process.env.VERCEL;
const ARQUIVO_PEDIDOS = NA_VERCEL
  ? path.join('/tmp', 'pedidos.json')
  : path.join(__dirname, 'pedidos.json');

let cache = null;

app.use(express.json({ limit: '30mb' })); // as fotos chegam em base64 no upload
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
  if (pagamento.metodo === 'cartao' && !pagamento.cartao?.numero) {
    return res.status(400).json({ erro: 'Dados do cartão não recebidos.' });
  }

  const pedidoId = gerarId();
  const base = {
    valorCentavos: VALOR_CENTAVOS,
    descricao: 'Kit Halteres Ajustavel 6 em 1',
    cliente: c,
    referencia: pedidoId,
    webhookUrl: process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/api/webhook/amplopay` : null,
  };

  // O pedido é gravado sem NENHUM dado de cartão — só os 4 últimos dígitos.
  function gravar(extra) {
    const pedidos = lerPedidos();
    pedidos[pedidoId] = {
      pedidoId,
      cliente: c,
      valor: PRECO,
      metodo: pagamento.metodo,
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

    console.log(`[pedido] ${pedidoId} PIX criado — ${c.nome} (${c.email})${pix.simulado ? ' [SIMULADO]' : ''}`);

    res.json({
      pedidoId,
      aprovado: false,
      pixCopiaECola: pix.pixCopiaECola,
      // Se o gateway não mandar a imagem, geramos o QR a partir do código.
      qrCodeImagem: pix.qrCodeImagem
        || `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(pix.pixCopiaECola)}`,
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

  if (!pedido.pago) {
    try {
      if (await consultarPago(pedido.transacaoId)) {
        pedido.pago = true;
        pedido.pagoEm = new Date().toISOString();
        salvarPedidos(pedidos);
        console.log(`[pago] ${pedido.pedidoId} — ${pedido.cliente.nome}`);
      }
    } catch (e) {
      console.error('[erro ao consultar status]', e.message);
    }
  }

  res.json({ pago: pedido.pago });
});

/* ---------- Webhook / postback da AmploPay ---------- */
app.post('/api/webhook/amplopay', (req, res) => {
  const corpo = req.body || {};
  console.log('[webhook amplopay]', JSON.stringify(corpo));

  const status = corpo.status || corpo.data?.status;
  const ref = corpo.externalRef || corpo.data?.externalRef || corpo.external_ref;
  const transacaoId = corpo.id || corpo.data?.id || corpo.transactionId;

  const pedidos = lerPedidos();
  const pedido = pedidos[ref] || Object.values(pedidos).find((p) => p.transacaoId === transacaoId);

  if (pedido && statusPago(status)) {
    pedido.pago = true;
    pedido.pagoEm = new Date().toISOString();
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
    console.log('  ⚠️  MODO SIMULADO — sem credenciais AmploPay no .env. Os PIX gerados NÃO são reais.\n');
  } else {
    console.log('  ✅ AmploPay conectada.\n');
  }
});
