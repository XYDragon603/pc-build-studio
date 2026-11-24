import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// 新界面（桌面窗口）；旧界面 App 待 codex 完成后移除
import App from './next/NextApp';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
