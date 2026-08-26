/**
 * VerificarAtualizacoesVendas.gs
 * ------------------------------------------------------------------------
 * Fica de olho no banco de VENDAS (e no de DISPONIBILIDADES) do Notion e,
 * assim que percebe que algo mudou lá, dispara na hora o rebuild do site
 * MAPA DE VENDAS (repositório SITE-DE-VENDAS no GitHub), em vez de esperar
 * alguém rodar o workflow manualmente.
 *
 * Como funciona:
 *   1. A cada N minutos (gatilho de tempo), pergunta ao Notion qual foi a
 *      página editada mais recentemente em cada banco (1 request por banco,
 *      ordenado por "last_edited_time" desc, page_size 1 — bem barato).
 *   2. Compara esse horário com o último horário que a gente já processou
 *      (guardado no Script Properties).
 *   3. Se tiver algo mais novo, chama a API do GitHub
 *      (POST /repos/{repo}/dispatches, evento "vendas_notion_update") pra
 *      acionar o workflow fetch_notion.yml, que busca os dados de novo e
 *      publica o site atualizado.
 *   4. Guarda o novo horário processado, pra não disparar de novo à toa.
 *
 * COMO PUBLICAR
 *   1. No repositório SITE-DE-VENDAS, abra qualquer arquivo .gs existente
 *      (ou crie um projeto novo em script.google.com) e cole este arquivo.
 *   2. Em "Configurações do projeto" → "Propriedades do script", cadastre:
 *        NOTION_TOKEN          -> o mesmo token usado no fetch_notion.py
 *        NOTION_DATABASE_ID    -> ID do banco de VENDAS
 *        NOTION_DATABASE_ID_DISP -> ID do banco de DISPONIBILIDADES
 *                                   (opcional — se vazio, só monitora VENDAS)
 *        GITHUB_TOKEN          -> Personal Access Token clássico, escopo "repo"
 *        GITHUB_REPO           -> "DEVMoraisEng/SITE-DE-VENDAS" (dono/repo)
 *   3. Rode testeToken() uma vez pelo editor pra confirmar que o token do
 *      Notion está funcionando (olhe os Logs de execução).
 *   4. Rode criarTrigger() uma vez pelo editor. Isso cria o gatilho
 *      automático que chama verificarAtualizacoes() a cada
 *      CONFIG.intervaloMinutos minutos, indefinidamente.
 *   5. Pronto — qualquer edição no Notion (VENDAS ou DISPONIBILIDADES)
 *      reflete no site em até CONFIG.intervaloMinutos minutos, sem precisar
 *      disparar nada manualmente. Pra desligar, rode removerTrigger().
 *
 * IMPORTANTE: também é preciso que o workflow
 * .github/workflows/fetch_notion.yml aceite o gatilho
 * "repository_dispatch: types: [vendas_notion_update]" — já incluído nesta
 * atualização do repositório.
 * ------------------------------------------------------------------------
 */

function prop_(nome) {
  return (PropertiesService.getScriptProperties().getProperty(nome) || '').trim();
}

var CONFIG = {
  notionToken:      prop_('NOTION_TOKEN'),
  dbVendas:         prop_('NOTION_DATABASE_ID'),
  dbDisponibilidades: prop_('NOTION_DATABASE_ID_DISP'),
  githubToken:      prop_('GITHUB_TOKEN'),
  githubRepo:       prop_('GITHUB_REPO'),      // "dono/repositorio"
  eventType:        'vendas_notion_update',
  intervaloMinutos: 10,
  propUltimoCheck:  'ULTIMO_LAST_EDITED_VENDAS'
};

/* ---------------------- Notion: última edição ---------------------- */

function notion_(caminho, corpo) {
  var resp = UrlFetchApp.fetch('https://api.notion.com/v1' + caminho, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + CONFIG.notionToken,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(corpo || {}),
    muteHttpExceptions: true
  });
  var codigo = resp.getResponseCode();
  if (codigo >= 300) {
    throw new Error('Notion API ' + codigo + ': ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Pega o "last_edited_time" da página editada mais recentemente num banco.
 * Retorna null se o banco estiver vazio ou o ID não estiver configurado.
 */
function ultimaEdicao_(dbId) {
  if (!dbId) return null;
  var dados = notion_('/databases/' + dbId + '/query', {
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    page_size: 1
  });
  var pagina = (dados.results || [])[0];
  return pagina ? pagina.last_edited_time : null;
}

/* ------------------------- GitHub: dispara build ------------------------- */

function dispararBuild_() {
  if (!CONFIG.githubRepo || !CONFIG.githubToken) {
    Logger.log('GITHUB_REPO/GITHUB_TOKEN não configurados — build não disparado.');
    return false;
  }
  var resp = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + CONFIG.githubRepo + '/dispatches',
    {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + CONFIG.githubToken,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      payload: JSON.stringify({ event_type: CONFIG.eventType }),
      muteHttpExceptions: true
    }
  );
  var codigo = resp.getResponseCode();
  if (codigo >= 300) {
    Logger.log('Falha ao disparar build (HTTP ' + codigo + '): ' + resp.getContentText());
    return false;
  }
  return true;
}

/* ----------------------------- Verificação ----------------------------- */

/**
 * Função principal, chamada pelo gatilho de tempo. Compara a edição mais
 * recente do Notion com a última que já processamos; se mudou, dispara o
 * rebuild do site e atualiza o marcador salvo.
 */
function verificarAtualizacoes() {
  if (!CONFIG.notionToken || !CONFIG.dbVendas) {
    Logger.log('NOTION_TOKEN/NOTION_DATABASE_ID não configurados.');
    return;
  }

  var maisRecente = ultimaEdicao_(CONFIG.dbVendas);
  var maisRecenteDisp = ultimaEdicao_(CONFIG.dbDisponibilidades);
  if (maisRecenteDisp && (!maisRecente || maisRecenteDisp > maisRecente)) {
    maisRecente = maisRecenteDisp;
  }
  if (!maisRecente) {
    Logger.log('Nenhum registro encontrado nos bancos monitorados.');
    return;
  }

  var propriedades = PropertiesService.getScriptProperties();
  var ultimoProcessado = propriedades.getProperty(CONFIG.propUltimoCheck);

  if (maisRecente === ultimoProcessado) {
    // nada mudou desde a última verificação
    return;
  }

  Logger.log('Mudança detectada no Notion (last_edited_time=' + maisRecente + '). Disparando build...');
  var ok = dispararBuild_();
  if (ok) {
    propriedades.setProperty(CONFIG.propUltimoCheck, maisRecente);
    Logger.log('Build disparado com sucesso.');
  }
}

/* --------------------------- Gatilho automático --------------------------- */

function criarTrigger() {
  removerTrigger();
  ScriptApp.newTrigger('verificarAtualizacoes')
    .timeBased()
    .everyMinutes(CONFIG.intervaloMinutos)
    .create();
  Logger.log('Gatilho criado: verificarAtualizacoes a cada ' + CONFIG.intervaloMinutos + ' min.');
}

function removerTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'verificarAtualizacoes') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/* ------------------------------ Testes manuais ------------------------------ */

function testeToken() {
  var r = ultimaEdicao_(CONFIG.dbVendas);
  Logger.log('Última edição no banco de VENDAS: ' + r);
}

function testeVerificacaoAgora() {
  // Força a verificação ignorando o marcador salvo, útil pra testar o
  // disparo do build sem esperar uma edição real no Notion.
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.propUltimoCheck);
  verificarAtualizacoes();
}
