
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig={
apiKey:"AIzaSyBmaFwXAXbJncyQHWNQ6bZnO6DmwPYeqXE",
authDomain:"programacao-producao.firebaseapp.com",
projectId:"programacao-producao",
storageBucket:"programacao-producao.firebasestorage.app",
messagingSenderId:"825932181496",
appId:"1:825932181496:web:81c88c614eda4a43f3700d"
}

const app=initializeApp(firebaseConfig)
export const auth=getAuth(app)
