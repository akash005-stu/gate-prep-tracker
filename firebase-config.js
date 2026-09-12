// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyB4NNO28ko1PZx7ID1Vh4pDvLzt2BB2uMQ",
  authDomain: "gate-5dcce.firebaseapp.com",
  databaseURL: "https://gate-5dcce-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "gate-5dcce",
  storageBucket: "gate-5dcce.firebasestorage.app",
  messagingSenderId: "857589547384",
  appId: "1:857589547384:web:9ec8dd0ec6bd21cc5ec88d",
  measurementId: "G-HJKQQQ4XEJ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
