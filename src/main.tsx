import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { RosterProvider } from './contexts/RosterContext';

// Intercept and suppress harmless third-party Firestore clock-drift warning
const originalConsoleError = console.error;
console.error = function (...args) {
  if (args.some(arg => typeof arg === 'string' && arg.includes('Detected an update time that is in the future'))) {
    return;
  }
  originalConsoleError.apply(console, args);
};

const originalConsoleWarn = console.warn;
console.warn = function (...args) {
  if (args.some(arg => typeof arg === 'string' && arg.includes('Detected an update time that is in the future'))) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RosterProvider>
      <App />
    </RosterProvider>
  </StrictMode>,
);
