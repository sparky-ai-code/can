import { parseHTML } from './src/browser/html.js';
import { renderPage, parseDecls } from './src/browser/render.js';
console.log(parseDecls('position:fixed;transform:translateY(-160%)'));
const html = `<!doctype html><html><head><style>body{margin:0}
.s{position:fixed;top:12px;left:12px;background:#fff;padding:12px;transform:translateY(-160%)}</style></head>
<body><a class="s" href="#">Skip</a></body></html>`;
const img = renderPage(parseHTML(html), { width: 200, height: 100 });
const counts = {};
for (let i = 0; i < img.data.length; i += 4) { const k = `${img.data[i]},${img.data[i+1]},${img.data[i+2]}`; counts[k] = (counts[k] || 0) + 1; }
console.log(Object.entries(counts).slice(0, 5));
