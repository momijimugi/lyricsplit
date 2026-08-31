/**
 * Firebase の設定値。
 *
 * Firebase Console > プロジェクトの設定 > マイアプリ（ウェブ）に表示される
 * firebaseConfig の中身を、そのまま下に貼り付けてください。
 *
 *   apiKey:            "AIza..."
 *   authDomain:        "xxxxx.firebaseapp.com"
 *   projectId:         "xxxxx"
 *   storageBucket:     "xxxxx.appspot.com"
 *   messagingSenderId: "000000000000"
 *   appId:             "1:000000000000:web:xxxxxxxx"
 *
 * ここに入る値は公開してよいもの（ブラウザに配られる識別子）で、秘密鍵ではない。
 * アクセス制御は Firebase Console 側の「承認済みドメイン」とセキュリティルールで行う。
 *
 * ※ 空のままにしておくと認証は無効になり、これまで通りログインなしで動く。
 *    値を入れてデプロイした時点で、Googleログインが必要になる。
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyDGuejFpTXjblX8sCFMDaBxgGKde2p7VKs',
  authDomain: 'soldb-ebb27.firebaseapp.com',
  projectId: 'soldb-ebb27',
  storageBucket: 'soldb-ebb27.firebasestorage.app',
  messagingSenderId: '941289825290',
  appId: '1:941289825290:web:e19fbbecb559317f9febf3',
  // Analytics は使っていないので参照されないが、Console の値をそのまま残しておく。
  measurementId: 'G-TRCDD1WNVF'
};

/** 設定が入っているか。未設定のうちは認証をまるごと素通りさせる。 */
export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
}
