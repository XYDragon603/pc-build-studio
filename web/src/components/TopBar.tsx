import { Download, Info, Monitor, NotebookText, Server } from 'lucide-react';

export type Connection = 'checking' | 'online' | 'offline';

const PILL: Record<Connection, { text: string; title: string }> = {
  checking: { text: '正在连接本地服务…', title: '' },
  online: { text: '已连接本地服务 · CPU / 显卡已接入查价', title: '方案保存到本地服务；其他配件暂为演示数据' },
  offline: { text: '演示模式 · 价格为演示数据', title: '本地服务未连接：运行 npm start 后刷新页面。方案暂存在浏览器。' },
};

export function TopBar({ connection, onPlans, onExport }: { connection: Connection; onPlans: () => void; onExport: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand"><Monitor size={26} strokeWidth={1.8} /> 装机工作台</span>
        <span className="divider" aria-hidden="true" />
        <span className={`demo-pill ${connection}`} title={PILL[connection].title}>
          {connection === 'online' ? <Server size={15} /> : <Info size={15} />} {PILL[connection].text}
        </span>
      </div>
      <nav className="topbar-right" aria-label="方案操作">
        <label className="region">
          <span className="sr-only">地区与币种</span>
          <select defaultValue="cn">
            <option value="cn">中国大陆 · CNY</option>
          </select>
        </label>
        <button type="button" className="btn btn-text" onClick={onPlans}><NotebookText size={18} /> 我的方案</button>
        <button type="button" className="btn btn-outline" onClick={onExport}><Download size={18} /> 导出清单</button>
      </nav>
    </header>
  );
}
