import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Made-up accounts and mail for screenshots (see src/demo.ts). Dev server only.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) {
  import('./demo').then(render);
} else {
  render();
}
