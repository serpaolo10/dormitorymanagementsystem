import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC39l8aJDsCdA9UBTyoOMMINX-k7DHuV1I',
  authDomain: 'dormitory-management-site.firebaseapp.com',
  projectId: 'dormitory-management-site',
  storageBucket: 'dormitory-management-site.firebasestorage.app',
  messagingSenderId: '476442113227',
  appId: '1:476442113227:web:9cba1bc51b3c67c9edd74e',
  measurementId: 'G-7JP4PM12M2'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
