/* FUVEST Tracker 2.0 — Auth + sincronização com controle de revisão.
   Nenhuma chave secreta fica no navegador. RLS protege as linhas no Supabase. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const authScreen = $('cloudAuthScreen');
  const emailInput = $('cloudEmail');
  const passwordInput = $('cloudPassword');
  const form = $('cloudAuthForm');
  const authMessage = $('cloudMessage');
  const button = $('cloudSubmit');
  const authSwitch = $('cloudSwitch');
  const forgot = $('cloudResetRequest');
  const cfg = window.FUVEST_CONFIG || {};
  let api, user = null, revision = null, ready = false;
  let mode = 'login', pending = null, flushing = false, flushTimer = null;
  let initFor = null, conflictRemote = null, conflictLocal = null;
  const clone = s => JSON.parse(JSON.stringify(s));
  const cacheKey = uid => 'fuvest-tracker-v2-sync-' + uid;
  const fresh = () => window.trackerCloudEmpty();
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  function setMessage(msg, good = false) {
    authMessage.textContent = msg;
    authMessage.classList.toggle('good',good);
  }
  function setStatus(msg, kind = '') {
    $('cloudStatus').textContent = msg;
    $('cloudStatus').className = kind;
  }
  function lock(msg = '') {
    ready = false;
    window.trackerCloudUserId = null;
    document.body.classList.remove('tracker-ready');
    authScreen.hidden = false;
    if (msg) setMessage(msg);
  }
  function unlock() {
    ready = true;
    window.trackerCloudUserId = user.id;
    authScreen.hidden = true;
    document.body.classList.add('tracker-ready');
  }
  function getCache(uid) {
    try {
      const data = JSON.parse(localStorage.getItem(cacheKey(uid)) || 'null');
      if (data && data.userId === uid && data.state && typeof data.state === 'object') return data;
    } catch (_) {}
    return null;
  }
  function putCache(state, dirty) {
    if (!user) return;
    try {
      localStorage.setItem(cacheKey(user.id),JSON.stringify({
        userId:user.id, revision, dirty, state:clone(state), savedAt:new Date().toISOString()
      }));
    } catch (_) { setStatus('Armazenamento local indisponível: exporte um backup', 'error'); }
  }
  function showMode(next) {
    mode = next;
    setMessage('');
    const isReset = next === 'reset';
    $('cloudIntro').textContent = next === 'signup'
      ? 'Crie uma conta para guardar seu progresso na nuvem.'
      : isReset ? 'Defina sua nova senha para continuar.'
      : 'Entre na sua conta para acessar o calendário, as questões e o progresso sincronizado.';
    button.textContent = next === 'signup' ? 'Criar conta' : isReset ? 'Salvar nova senha' : 'Entrar';
    $('cloudPasswordLabel').textContent = isReset ? 'Nova senha' : 'Senha';
    passwordInput.autocomplete = next === 'login' ? 'current-password' : 'new-password';
    emailInput.parentElement && (emailInput.disabled = isReset);
    authSwitch.textContent = next === 'signup' ? 'Já tenho conta' : 'Criar conta';
    forgot.hidden = next !== 'login';
    $('cloudAuthActions').hidden = isReset;
  }
  function presentConflict(remoteState, localState) {
    conflictRemote = clone(remoteState);
    conflictLocal = clone(localState);
    $('cloudConflict').classList.add('open');
    setStatus('Conflito: escolha qual versão manter', 'error');
  }
  function hideConflict() { $('cloudConflict').classList.remove('open'); }
  function exportJson(state) {
    const data = JSON.stringify({version:1, exportedAt:new Date().toISOString(), state},null,2);
    const url = URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const a = document.createElement('a'); a.href = url;
    a.download = 'fuvest-tracker-copia-local-' + new Date().toISOString().slice(0,10) + '.json';
    a.click(); setTimeout(()=>URL.revokeObjectURL(url),2000);
  }
  async function fetchRow() {
    const {data,error} = await api.from('tracker_state')
      .select('data, revision, updated_at').eq('user_id',user.id).maybeSingle();
    if (error) throw error;
    if (data) return data;
    const {data:created,error:insertErr} = await api.from('tracker_state')
      .insert({user_id:user.id,data:fresh(),revision:1})
      .select('data, revision, updated_at').single();
    if (!insertErr) return created;
    // Outro dispositivo pode ter criado a linha no mesmo instante.
    const {data:existing,error:retryErr} = await api.from('tracker_state')
      .select('data, revision, updated_at').eq('user_id',user.id).single();
    if (retryErr) throw retryErr;
    return existing;
  }
  async function initAccount(account) {
    if (!account || (initFor === account.id && (ready || !window.trackerCloudUserId))) return;
    initFor = account.id;
    user = account;
    ready = false;
    lock();
    setMessage('Carregando seu progresso na nuvem...', true);
    setStatus('Buscando progresso...');
    try {
      const remote = await fetchRow();
      // Uma troca de conta durante a requisição não deve carregar dados de outro usuário.
      if (!user || user.id !== account.id) return;
      revision = Number(remote.revision);
      const saved = getCache(user.id);
      const remoteState = remote.data && typeof remote.data === 'object' ? remote.data : fresh();
      if (saved?.dirty) {
        if (same(saved.state,remoteState)) {
          pending = null; putCache(remoteState,false);
          window.trackerCloudApply(remoteState); unlock(); setStatus('Sincronizado');
        } else if (saved.revision === revision) {
          pending = clone(saved.state);
          window.trackerCloudApply(pending); unlock();
          setStatus('Enviando alterações pendentes...', 'warn');
          scheduleFlush();
        } else {
          // Não substitui nenhuma das cópias sem escolha explícita.
          pending = clone(saved.state);
          window.trackerCloudApply(pending); unlock();
          presentConflict(remoteState,pending);
        }
      } else {
        pending = null;
        putCache(remoteState,false);
        window.trackerCloudApply(remoteState);
        unlock(); setStatus('Sincronizado');
      }
      setMessage('');
    } catch (err) {
      initFor = null;
      lock('Falha ao carregar seus dados. Confira a internet, a configuração do Supabase e se o SQL foi executado. Detalhes: '+(err?.message||err));
      setStatus('Falha na conexão', 'error');
    }
  }
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush,650);
  }
  function queueSave(state) {
    if (!user || !ready) return;
    pending = clone(state);
    putCache(pending,true);
    setStatus('Aguardando sincronização...', 'warn');
    scheduleFlush();
  }
  async function flush() {
    if (flushing || !ready || !user || !pending || $('cloudConflict').classList.contains('open')) return;
    flushing = true;
    const activeUid = user.id;
    try {
      while (ready && user?.id === activeUid && pending) {
        const snapshot = clone(pending);
        const fromRevision = revision;
        setStatus('Sincronizando...', 'warn');
        const {data,error} = await api.from('tracker_state')
          .update({data:snapshot,revision:fromRevision+1,updated_at:new Date().toISOString()})
          .eq('user_id',activeUid).eq('revision',fromRevision)
          .select('revision');
        if (error) throw error;
        if (!data?.length) {
          const remote = await fetchRow();
          revision = Number(remote.revision);
          if (same(remote.data,pending)) {
            pending = null; putCache(remote.data,false); setStatus('Sincronizado');
          } else {
            presentConflict(remote.data,pending);
          }
          break;
        }
        revision = Number(data[0].revision);
        if (same(pending,snapshot)) {
          pending = null;
          putCache(snapshot,false);
          setStatus('Sincronizado');
        } else {
          // Houve mais alterações enquanto esta requisição era enviada.
          putCache(pending,true);
        }
      }
    } catch (err) {
      setStatus('Não sincronizado; dados guardados neste navegador', 'error');
      console.warn('Erro de sincronização:',err);
    } finally { flushing = false; }
  }
  window.trackerCloudSave = queueSave;
  $('cloudExportConflict').onclick = () => exportJson(conflictLocal);
  $('cloudUseRemote').onclick = () => {
    if (!user || !conflictRemote) return;
    pending = null;
    window.trackerCloudApply(conflictRemote);
    putCache(conflictRemote,false);
    hideConflict(); setStatus('Versão da nuvem carregada');
  };
  $('cloudUseLocal').onclick = () => {
    if (!user || !conflictLocal) return;
    pending = clone(conflictLocal);
    window.trackerCloudApply(pending);
    putCache(pending,true);
    hideConflict(); setStatus('Enviando versão local...', 'warn');
    scheduleFlush();
  };
  $('cloudSignOut').onclick = async () => {
    if (pending && !confirm('Há alterações não sincronizadas. Exporte um backup antes de sair. Deseja sair mesmo assim?')) return;
    const {error} = await api.auth.signOut();
    if (error) { setStatus('Não foi possível sair da conta', 'error'); return; }
    user = null; initFor = null; revision = null; pending = null;
    window.trackerCloudUserId = null;
    lock(); showMode('login');
    setStatus('Desconectado');
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!api) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || password.length < 6) { setMessage('Digite um e-mail válido e uma senha de pelo menos 6 caracteres.'); return; }
    button.disabled = true;
    setMessage('Aguarde a resposta do serviço...', true);
    try {
      if (mode === 'reset') {
        const {error} = await api.auth.updateUser({password});
        if (error) throw error;
        await initAccount((await api.auth.getUser()).data.user); setStatus('Senha atualizada · sincronizado');
      } else if (mode === 'signup') {
        const {data,error} = await api.auth.signUp({email,password});
        if (error) throw error;
        if (data.session?.user) await initAccount(data.session.user);
        else { showMode('login'); setMessage('Conta criada. Confira seu e-mail para confirmar o cadastro antes de entrar.',true); }
      } else {
        const {data,error} = await api.auth.signInWithPassword({email,password});
        if (error) throw error;
        if (data.user) await initAccount(data.user);
      }
    } catch (err) { setMessage(err?.message||'Não foi possível concluir a solicitação.'); }
    finally { button.disabled = false; }
  };
  authSwitch.onclick = () => showMode(mode === 'signup'?'login':'signup');
  forgot.onclick = async () => {
    if (!api) return;
    const email = emailInput.value.trim();
    if (!email) { setMessage('Digite seu e-mail no campo acima para recuperar a senha.'); return; }
    const redirectTo = location.origin + location.pathname;
    const {error} = await api.auth.resetPasswordForEmail(email,{redirectTo});
    setMessage(error ? error.message : 'Se o e-mail estiver cadastrado, enviaremos instruções para redefinir a senha.',!error);
  };
  window.addEventListener('online', () => { if (pending) scheduleFlush(); });
  window.addEventListener('visibilitychange', () => { if (!document.hidden && pending) scheduleFlush(); });
  window.addEventListener('beforeunload', (e) => {
    if (pending) { e.preventDefault(); e.returnValue = ''; }
  });
  async function boot() {
    lock();
    const valid = typeof cfg.url === 'string' && /^https:\/\/[^\s]+\.supabase\.co\/?$/.test(cfg.url)
      && typeof cfg.publishableKey === 'string' && cfg.publishableKey.length > 20;
    if (!valid) {
      form.hidden = true; $('cloudAuthActions').hidden = true;
      setMessage('Configuração pendente: preencha o arquivo config.js com a Project URL e a publishable key do Supabase. Consulte o LEIA-ME.md.');
      return;
    }
    if (!window.supabase?.createClient) {
      form.hidden = true; $('cloudAuthActions').hidden = true;
      setMessage('Não foi possível carregar a biblioteca do Supabase. Verifique sua conexão com a internet e recarregue.');
      return;
    }
    api = window.supabase.createClient(cfg.url,cfg.publishableKey);
    api.auth.onAuthStateChange((event,session) => {
      // O callback não espera requisições: evita deadlocks do cliente de autenticação.
      if (event === 'PASSWORD_RECOVERY') {
        initFor = null; lock(); showMode('reset'); setMessage('Crie uma nova senha.',true);
      } else if (event === 'SIGNED_OUT') {
        user = null; initFor = null; pending = null; revision = null;
        lock(); showMode('login');
      } else if (event === 'SIGNED_IN' && session?.user) {
        setTimeout(() => initAccount(session.user),0);
      }
    });
    try {
      const {data,error} = await api.auth.getSession();
      if (error) throw error;
      if (data.session?.user) await initAccount(data.session.user);
      else { showMode('login'); setStatus('Faça login'); }
    } catch (err) { setMessage('Erro ao verificar sessão: '+(err?.message||err)); }
  }
  boot();
})();
