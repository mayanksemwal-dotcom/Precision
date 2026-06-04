import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc, query, where, writeBatch } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.GEMINI_API_KEY, // Mock, wait we don't have secrets.
};
