/* ==========================================================================
   LYRICLAB — Googleログイン（Firebase Authentication）

   既存のアプリ（app.js）には手を触れず、その外側に認証の層をかぶせるだけの
   モジュール。app.js は今までどおり読み込まれてそのまま動き、このファイルは
   「本体を見せるかどうか」と「ヘッダーにアカウントを出すか」だけを受け持つ。

   状態は <html data-auth> の3つ。CSSはこの属性だけを見る。
     checking … 認証状態の確認中。本体もログイン画面も出さない
     out      … 未ログイン。ログイン画面だけを出す
     in       … ログイン済み。本体を出す

   firebase-config.js が未設定のあいだは認証を丸ごと素通りさせ、
   これまで通りログインなしで使える状態を保つ。
   ========================================================================== */

import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js?v=1.4.0';

// Firebase公式のブラウザ向けES Modules。ビルド環境は使わない。
// 版を上げるときは3か所ともそろえること。
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1';

const $ = (id) => document.getElementById(id);
const setAuthState = (state) => { document.documentElement.dataset.auth = state; };

/**
 * 他のスクリプトから uid / displayName / email を読めるようにしておく。
 * 今回はここまでで、既存の作業者IDや共同編集データへの紐付けはまだ行わない。
 */
const listeners = [];
window.LYRICLAB_AUTH = {
  enabled: false,
  user: null,
  get uid() { return this.user ? this.user.uid : null; },
  get displayName() { return this.user ? this.user.displayName : null; },
  get email() { return this.user ? this.user.email : null; },
  /** 認証状態が変わるたびに呼ばれる。登録時点の状態でも1回呼ぶ。 */
  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.push(fn);
    try { fn(this.user); } catch (e) { console.error(e); }
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }
};

function publish(user) {
  window.LYRICLAB_AUTH.user = user;
  listeners.forEach((fn) => { try { fn(user); } catch (e) { console.error(e); } });
}

function showError(message) {
  const el = $('auth-error');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

/** ヘッダーのアカウント表示。名前とアイコン、ログアウトボタン。 */
function renderAccount(user) {
  const wrap = $('auth-user');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !user);
  if (!user) return;

  const name = user.displayName || user.email || 'ログイン中';
  $('auth-user-name').textContent = name;
  wrap.title = [user.displayName, user.email].filter(Boolean).join(' · ');

  const img = $('auth-user-photo');
  const initial = $('auth-user-initial');
  if (user.photoURL) {
    img.src = user.photoURL;
    img.alt = name;
    img.classList.remove('hidden');
    initial.classList.add('hidden');
  } else {
    // 画像が無いアカウントもあるので、頭文字で代用する。
    img.classList.add('hidden');
    initial.textContent = name.slice(0, 1);
    initial.classList.remove('hidden');
  }
}

/** 未設定のときは認証を挟まず、これまで通りの動作に戻す。 */
function runWithoutAuth(reason) {
  if (reason) console.warn('[LYRICLAB] Googleログインは無効です:', reason);
  window.LYRICLAB_AUTH.enabled = false;
  renderAccount(null);
  publish(null);
  setAuthState('in');
}

async function boot() {
  if (!isFirebaseConfigured()) {
    runWithoutAuth('firebase-config.js が未設定です。設定値を入れるとログインが有効になります。');
    return;
  }

  let auth, provider, signInWithPopup, signOut;
  try {
    const [{ initializeApp }, authMod] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`)
    ]);
    const app = initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    provider = new authMod.GoogleAuthProvider();
    signInWithPopup = authMod.signInWithPopup;
    signOut = authMod.signOut;

    // リロードしてもログイン状態を保つ（ブラウザに保存）。既定と同じだが明示しておく。
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);

    window.LYRICLAB_AUTH.enabled = true;

    authMod.onAuthStateChanged(auth, (user) => {
      showError('');
      renderAccount(user);
      publish(user);
      setAuthState(user ? 'in' : 'out');
    }, (err) => {
      console.error('[LYRICLAB] onAuthStateChanged', err);
      showError('ログイン状態を確認できませんでした。再読み込みしてください。');
      setAuthState('out');
    });
  } catch (e) {
    // SDKが読めない・設定値が不正といった段階の失敗。
    // ここで本体を閉じたままにすると何もできなくなるので、認証なしで通す。
    runWithoutAuth(e && e.message ? e.message : e);
    return;
  }

  const btn = $('auth-signin');
  if (btn) {
    btn.addEventListener('click', async () => {
      showError('');
      btn.disabled = true;
      try {
        await signInWithPopup(auth, provider);
        // 画面の切り替えは onAuthStateChanged 側で行う。
      } catch (e) {
        showError(signInErrorMessage(e));
      } finally {
        btn.disabled = false;
      }
    });
  }

  const out = $('auth-signout');
  if (out) {
    out.addEventListener('click', async () => {
      try {
        await signOut(auth);
      } catch (e) {
        showError((e && e.message) || String(e));
      }
    });
  }
}

/** よくある失敗は、原因が分かる日本語にして画面に出す。 */
function signInErrorMessage(e) {
  const code = (e && e.code) || '';
  if (code === 'auth/popup-blocked') {
    return 'ブラウザにポップアップを塞がれました。このサイトのポップアップを許可してから、もう一度お試しください。';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return '';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'このドメインはFirebaseで許可されていません。Firebase Console の Authentication > Settings > 承認済みドメイン に、このサイトのドメインを追加してください。';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Googleログインが有効になっていません。Firebase Console の Authentication > Sign-in method で Google を有効にしてください。';
  }
  if (code === 'auth/network-request-failed') {
    return 'ネットワークに接続できませんでした。通信状況を確認してください。';
  }
  return 'ログインできませんでした。' + ((e && e.message) || '');
}

boot();
