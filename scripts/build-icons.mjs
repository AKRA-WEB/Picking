import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const html = await fs.readFile(path.join(root, "index.html"), "utf8");
const names = [...new Set([...html.matchAll(/data-lucide="([^"]+)"/g)].map((match) => match[1]))].sort();
const icons = {};

for (const name of names) {
  const file = path.join(root, "node_modules", "lucide", "dist", "esm", "icons", name + ".js");
  const module = await import(pathToFileURL(file).href);
  icons[name] = module.default[2];
}

const runtime = `(function(){const icons=${JSON.stringify(icons)};const base={xmlns:"http://www.w3.org/2000/svg",width:"24",height:"24",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"2","stroke-linecap":"round","stroke-linejoin":"round"};function create(){document.querySelectorAll("[data-lucide]").forEach(function(el){const nodes=icons[el.getAttribute("data-lucide")];if(!nodes)return;const svg=document.createElementNS(base.xmlns,"svg");Object.keys(base).forEach(function(key){svg.setAttribute(key,base[key]);});[...el.attributes].forEach(function(attr){if(attr.name!=="data-lucide")svg.setAttribute(attr.name,attr.value);});svg.setAttribute("aria-hidden","true");nodes.forEach(function(node){const child=document.createElementNS(base.xmlns,node[0]);Object.keys(node[1]).forEach(function(key){child.setAttribute(key,node[1][key]);});svg.appendChild(child);});el.replaceWith(svg);});}window.lucide={createIcons:create};})();`;

await fs.writeFile(path.join(root, "assets", "lucide.min.js"), runtime);
console.log(`Built ${names.length} local Lucide icons.`);
