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
const FRETE = Number(process.env.SHIPPING_PRICE || 19.9); // fixo, qualquer CEP
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
/**
 * Avisa Meta e Utmify da venda, uma única vez por pedido.
 *
 * Precisa de await: na Vercel a função serverless é congelada assim que a
 * resposta HTTP sai, e qualquer promessa pendente morre com ela — era por isso
 * que o "paid" não chegava na Utmify enquanto o "waiting_payment" chegava (esse
 * sai junto da criação do Pix, que ainda tem trabalho pela frente).
 *
 * A flag só é marcada DEPOIS do envio confirmado. Se marcássemos antes e o
 * envio falhasse, o reenvio do webhook pela ZuckPay seria bloqueado pelo guard
 * e a venda ficaria para sempre sem registro.
 */
async function marcarConversao(pedido) {
  if (pedido.conversaoEnviada) return;

  const [enviouMeta, enviouUtmify] = await Promise.all([
    meta.enviarCompra(pedido).catch((e) => { console.error('[meta] falhou:', e.message); return false; }),
    utmify.enviarPedido(pedido, 'paid'),
  ]);

  // A flag só fecha quando os DOIS aceitaram. Antes ela olhava apenas a Utmify:
  // se o Meta falhasse, o reenvio era bloqueado e a venda nunca aparecia lá.
  // Repetir é seguro — o Meta deduplica pelo event_id (= número do pedido) e a
  // Utmify atualiza o mesmo orderId em vez de criar outro.
  if (enviouMeta && enviouUtmify) {
    pedido.conversaoEnviada = true;
  } else {
    const falhou = [!enviouMeta && 'Meta', !enviouUtmify && 'Utmify'].filter(Boolean).join(' e ');
    console.error(`[conversao] pedido ${pedido.pedidoId}: ${falhou} não confirmou — será reenviado.`);
  }
}

function gerarId() {
  return 'CO' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
}

/**
 * Monta a URL que a ZuckPay chama para confirmar o pagamento.
 *
 * Depender só do PUBLIC_URL já custou vendas: se a variável fica vazia o
 * callbackUrl vai `null` e a confirmação nunca chega — e o pedido pendente
 * continua sendo registrado normalmente, porque esse é enviado por nós na
 * criação do Pix. O sintoma é justamente "pendente aparece, aprovado não".
 *
 * Então: usa o PUBLIC_URL quando existir (sem barra sobrando no fim, que
 * geraria //api/webhook) e cai para o próprio host da requisição quando não.
 * O valor final é logado porque na Vercel o PUBLIC_URL fica marcado como
 * Sensitive — nem o painel mostra o conteúdo, só o log revela o que foi usado.
 */
function urlDoWebhook(req) {
  const configurado = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configurado) return `${configurado}/api/webhook/zuckpay`;

  const proto = req.get('x-forwarded-proto') || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return null;
  console.warn('[aviso] PUBLIC_URL vazio — usando o host da requisição para o callback.');
  return `${proto}://${host}/api/webhook/zuckpay`;
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
  const valorTotal = Number((PRECO * quantidade + FRETE).toFixed(2));
  if (pagamento.metodo === 'cartao' && !pagamento.cartao?.numero) {
    return res.status(400).json({ erro: 'Dados do cartão não recebidos.' });
  }

  const pedidoId = gerarId();
  const base = {
    valor: valorTotal,
    descricao: quantidade > 1 ? `${DESCRICAO} (${quantidade}x)` : DESCRICAO,
    cliente: c,
    referencia: pedidoId,
    callbackUrl: urlDoWebhook(req),
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
    // Sem esse log não há como saber para onde a confirmação foi pedida: o
    // PUBLIC_URL é Sensitive na Vercel e não aparece nem no painel.
    console.log(`[pedido] ${pedidoId} callback do webhook: ${base.callbackUrl}`);

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
        await marcarConversao(pedido);
      }
    } catch (e) {
      console.error('[erro ao consultar status]', e.message);
    }
    salvarPedidos(pedidos);
  }

  res.json({ pago: pedido.pago });
});

/* ---------- Webhook / postback da ZuckPay (urlnoty) ---------- */
app.post('/api/webhook/zuckpay', async (req, res) => {
  const corpo = req.body || {};
  console.log('[webhook zuckpay]', JSON.stringify(corpo));

  // Caminho rápido: assinatura confere e seguimos direto.
  //
  // Quando NÃO confere, o código antigo recusava com 401 e a venda morria ali.
  // Bastava o secret da Vercel estar diferente do painel — ou a ZuckPay mandar
  // o postback sem o cabeçalho — para toda venda aprovada sumir, enquanto a
  // pendente continuava certa (essa sai daqui, na criação do Pix).
  //
  // Agora, em vez de descartar, perguntamos à própria ZuckPay se a transação
  // está paga. Continua seguro: quem decide é a API do gateway, não o corpo que
  // chegou. Forjar exigiria um transactionId real e já pago da sua conta — que
  // geraria a mesma conversão de qualquer forma.
  const assinaturaOk = assinaturaConfigurada()
    && verificarAssinatura(req.rawBody, req.get('X-ZuckPay-Signature'));

  if (assinaturaConfigurada() && !assinaturaOk) {
    console.warn('[webhook zuckpay] assinatura não confere — vou confirmar na API da ZuckPay antes de decidir.');
  } else if (!assinaturaConfigurada() && !modoSimulado()) {
    console.warn('[webhook zuckpay] sem ZUCKPAY_WEBHOOK_SECRET: confirmação virá da API da ZuckPay.');
  }

  // Formato oficial: { event, platform, transaction: {...} }. O postback do
  // SPEI vem sem o envelope, então aceitamos o corpo direto também.
  const t = corpo.transaction || corpo.data || corpo;
  const status = t.status;
  const ref = t.external_id_client || t.external_id;
  const transacaoId = t.id || t.transactionId;

  // "Está pago" só vale se a assinatura conferiu OU se a ZuckPay confirmar na
  // API. Sem uma das duas coisas não registramos conversão nenhuma.
  let confirmadoPago = statusPago(status);
  if (confirmadoPago && !assinaturaOk && !modoSimulado()) {
    if (!transacaoId) {
      console.error('[webhook zuckpay] postback sem assinatura válida e sem id de transação — recusado.');
      return res.sendStatus(401);
    }
    try {
      confirmadoPago = await consultarPago(transacaoId);
    } catch (e) {
      // Não deu para confirmar agora: 500 faz a ZuckPay tentar de novo, o que é
      // melhor do que dar a venda por perdida com um 200.
      console.error('[webhook zuckpay] falha ao consultar a ZuckPay:', e.message);
      return res.sendStatus(500);
    }
    if (!confirmadoPago) {
      console.error(`[webhook zuckpay] a ZuckPay não confirma a transação ${transacaoId} como paga — recusado.`);
      return res.sendStatus(401);
    }
    console.log(`[webhook zuckpay] transação ${transacaoId} confirmada direto na API (assinatura não conferiu).`);
  }

  const pedidos = lerPedidos();
  let pedido = pedidos[ref] || Object.values(pedidos).find((p) => p.transacaoId === transacaoId);

  // O /tmp da Vercel some quando a função hiberna, então o webhook quase sempre
  // cai numa instância que não tem o pedido gravado. Antes o código só ignorava
  // e respondia 200 — a ZuckPay dava a entrega por certa e a venda nunca era
  // registrada na Utmify. Como o postback traz os dados do cliente e o valor,
  // reconstruímos o pedido aqui em vez de perder a conversão.
  if (!pedido && ref && confirmadoPago) {
    const valorRecebido = Number(t.valor ?? t.amount ?? 0);
    pedido = {
      pedidoId: ref,
      transacaoId,
      valor: valorRecebido > 0 ? valorRecebido : PRECO + FRETE,
      // desconta o frete fixo antes de estimar quantas unidades foram pagas
      quantidade: valorRecebido > 0 ? Math.max(1, Math.round((valorRecebido - FRETE) / PRECO)) : 1,
      metodo: 'pix',
      cliente: {
        nome: t.nome || t.customer?.name || null,
        email: t.email || t.customer?.email || null,
        cpf: t.cpf || t.customer?.document || null,
        telefone: t.telefone || t.customer?.phone || null,
      },
      utms: t.trackingParameters || {},
      criadoEm: new Date().toISOString(),
      reconstruido: true,
    };
    pedidos[ref] = pedido;
    console.warn(`[webhook zuckpay] pedido ${ref} não estava no /tmp — reconstruído do postback.`);
  }

  if (pedido && confirmadoPago) {
    pedido.pago = true;
    pedido.pagoEm = new Date().toISOString();
    // Grava só depois do envio: marcarConversao atualiza conversaoEnviada e
    // esse valor precisa entrar no arquivo junto.
    await marcarConversao(pedido);
    salvarPedidos(pedidos);
    console.log(`[pago via webhook] ${pedido.pedidoId}`);
  } else if (!pedido) {
    console.error(`[webhook zuckpay] pedido não encontrado (ref=${ref}, transacao=${transacaoId}) — nada enviado.`);
  } else {
    // Pendente é rotina. Qualquer outra grafia é suspeita de venda perdida:
    // respondemos 200 e a ZuckPay não retenta, então precisa gritar no log.
    const rotina = ['PENDING', 'PENDING_3DS', 'WAITING', 'WAITING_PAYMENT', 'CREATED'];
    if (rotina.includes(String(status || '').toUpperCase().trim())) {
      console.log(`[webhook zuckpay] ${pedido.pedidoId} ainda "${status}" — aguardando pagamento.`);
    } else {
      console.error(`[ATENCAO] ${pedido.pedidoId} veio com status "${status}", que não está na lista de pagos nem de pendentes. Se essa venda foi aprovada, a conversão NÃO foi enviada — inclua a string em STATUS_PAGOS no zuckpay.js.`);
    }
  }

  res.sendStatus(200);
});

/* ---------- Recupera manualmente uma venda que não foi registrada ----------
   Existe porque uma confirmação perdida (assinatura recusada, callbackUrl
   errado, status com outra grafia) é dinheiro que a Utmify nunca vê, e o
   postback da ZuckPay não fica disponível para sempre.

   Confere na ZuckPay se a transação está realmente paga antes de enviar
   qualquer conversão — nunca aceita "está pago" vindo de quem chamou.

   Protegido por ADMIN_TOKEN. Sem essa variável no ambiente o endpoint fica
   desligado, para não virar porta aberta para inflar conversões.            */
function autorizadoAdmin(req, res, oQue) {
  const esperado = process.env.ADMIN_TOKEN;
  if (!esperado) {
    res.status(403).json({ erro: `${oQue} desativado: falta ADMIN_TOKEN no ambiente.` });
    return false;
  }
  if (req.get('x-admin-token') !== esperado) {
    res.status(401).json({ erro: 'Token inválido.' });
    return false;
  }
  return true;
}

/* ---------- Mostra COMO o servidor está configurado ----------
   Na Vercel as variáveis viram "Sensitive" e nem o painel mostra o valor, o que
   deixa a gente adivinhando quando o rastreamento falha. Aqui expomos o estado
   da configuração — nunca o conteúdo de um segredo, só se está presente e o
   tamanho, mais o que dá para conferir a olho (a URL pública e o callback que
   seria enviado à ZuckPay, que não são segredo).                              */
app.get('/api/admin/diagnostico', (req, res) => {
  if (!autorizadoAdmin(req, res, 'Diagnóstico')) return;

  const presente = (v) => ({ definida: !!v, tamanho: v ? String(v).length : 0 });

  res.json({
    ambiente: NA_VERCEL ? 'vercel' : 'local',
    modoSimulado: modoSimulado(),
    publicUrl: process.env.PUBLIC_URL || null, // é público por natureza
    callbackQueSeriaEnviado: urlDoWebhook(req),
    // Arredondado igual ao cobrado de verdade, senão o ponto flutuante mostra
    // 88.80000000000001 aqui e parece bug onde não há.
    precoEFrete: { produto: PRECO, frete: FRETE, total1un: Number((PRECO + FRETE).toFixed(2)) },
    zuckpay: {
      clientId: presente(process.env.ZUCKPAY_CLIENT_ID),
      clientSecret: presente(process.env.ZUCKPAY_CLIENT_SECRET),
      webhookSecret: presente(process.env.ZUCKPAY_WEBHOOK_SECRET),
      assinaturaExigida: assinaturaConfigurada(),
    },
    utmify: { token: presente(process.env.UTMIFY_API_TOKEN), ativo: utmify.ativo() },
    meta: {
      pixelId: process.env.META_PIXEL_ID || null, // já aparece no HTML da página
      capiToken: presente(process.env.META_CAPI_TOKEN),
      ativo: meta.ativo(),
    },
  });
});

app.post('/api/admin/reconciliar', async (req, res) => {
  if (!autorizadoAdmin(req, res, 'Reconciliação')) return;

  const { transacaoId, pedidoId, cliente, valor, quantidade, utms } = req.body || {};
  if (!transacaoId || !pedidoId) {
    return res.status(400).json({ erro: 'Informe transacaoId e pedidoId.' });
  }

  try {
    if (!await consultarPago(transacaoId)) {
      return res.status(409).json({ erro: 'A ZuckPay não confirma essa transação como paga.' });
    }
  } catch (e) {
    return res.status(502).json({ erro: `Não consegui consultar a ZuckPay: ${e.message}` });
  }

  const pedidos = lerPedidos();
  const pedido = pedidos[pedidoId] || {
    pedidoId,
    transacaoId,
    valor: Number(valor) || PRECO + FRETE,
    quantidade: Math.max(1, Number(quantidade) || 1),
    metodo: 'pix',
    cliente: cliente || {},
    utms: utms || {},
    criadoEm: new Date().toISOString(),
    recuperadoManualmente: true,
  };

  if (pedido.conversaoEnviada) {
    return res.json({ ok: true, jaEnviado: true, pedidoId });
  }

  pedido.pago = true;
  pedido.pagoEm = pedido.pagoEm || new Date().toISOString();
  pedidos[pedidoId] = pedido;

  await marcarConversao(pedido);
  salvarPedidos(pedidos);

  console.log(`[reconciliado] ${pedidoId} — conversão ${pedido.conversaoEnviada ? 'enviada' : 'AINDA pendente'}`);
  res.json({ ok: true, pedidoId, conversaoEnviada: !!pedido.conversaoEnviada });
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
  console.log(`  Produto: R$ ${PRECO.toFixed(2).replace('.', ',')} + Frete: R$ ${FRETE.toFixed(2).replace('.', ',')}`);
  if (modoSimulado()) {
    console.log('  ⚠️  MODO SIMULADO — sem credenciais ZuckPay no .env. Os PIX gerados NÃO são reais.\n');
  } else {
    console.log('  ✅ ZuckPay conectada.\n');
  }
});
