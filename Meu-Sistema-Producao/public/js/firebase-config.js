import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBmaFwXAXbJncyQHWNQ6bZnO6DmwPYeqXE",
  authDomain: "programacao-producao.firebaseapp.com",
  projectId: "programacao-producao",
  storageBucket: "programacao-producao.firebasestorage.app",
  messagingSenderId: "825932181496",
  appId: "1:825932181496:web:81c88c614eda4a43f3700d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Sessão apenas por aba — ao fechar o browser/aba o login expira
setPersistence(auth, browserSessionPersistence).catch(console.error);

export { firebaseConfig };
