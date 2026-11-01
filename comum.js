// Utilitários partilhados pelas páginas públicas e de administração
export const C = window.CNB_CONFIG;
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const mt = (v) => `${Number(v || 0).toLocaleString("pt-PT", { maximumFractionDigits: 0 })} MT`;
export const data = (iso, op = {}) => iso ? new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeStyle: "short", timeZone: C.FUSO, ...op }).format(new Date(iso)) : "";
export const dataCurta = (iso) => iso ? new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: C.FUSO }).format(new Date(iso)) : "";
export const hora = (iso) => iso ? new Intl.DateTimeFormat("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: C.FUSO }).format(new Date(iso)) : "";
export const param = (k) => new URLSearchParams(location.search).get(k);

// Markdown mínimo (negrito, listas numeradas, parágrafos) para os termos
export function md(texto) {
  const linhas = String(texto || "").split(/\r?\n/); let html = "", lista = false;
  for (const l of linhas) {
    const t = l.trim(); const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^\d+\.\s/.test(t)) { if (!lista) { html += "<ol>"; lista = true; } html += `<li>${inline(t.replace(/^\d+\.\s/, ""))}</li>`; continue; }
    if (lista) { html += "</ol>"; lista = false; }
    if (t) html += `<p>${inline(t)}</p>`;
  }
  if (lista) html += "</ol>"; return html;
}

export function mostrarErro(el, e) { el.className = "erro"; el.textContent = typeof e === "string" ? e : (e?.message || e?.error_description || "Ocorreu um erro"); el.classList.remove("oculto"); }

export function telemovelValido(t) { const d = String(t || "").replace(/\D/g, ""); return (d.length === 9 && d.startsWith("8")) || (d.length === 12 && d.startsWith("258")) || d.length >= 10; }
