import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { EXPORT_META, exportableEntries, renderExport } from '../lib/export';
export function ExportPanel({ entries }) {
    const [format, setFormat] = useState('csv');
    const [includeUnverified, setIncludeUnverified] = useState(false);
    const content = useMemo(() => renderExport(format, entries, includeUnverified), [format, entries, includeUnverified]);
    const count = exportableEntries(entries, includeUnverified).length;
    const download = () => {
        const meta = EXPORT_META[format];
        const blob = new Blob([content], { type: meta.mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bookshelf.${meta.ext}`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(content);
        }
        catch {
            /* クリップボードが使えない環境ではテキスト欄から手動コピーしてもらう */
        }
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "export-row", children: [_jsx("select", { value: format, onChange: (e) => setFormat(e.target.value), style: { width: 'auto' }, "aria-label": "\u51FA\u529B\u5F62\u5F0F", children: Object.keys(EXPORT_META).map((f) => (_jsx("option", { value: f, children: EXPORT_META[f].label }, f))) }), _jsx("button", { className: "primary", onClick: download, disabled: count === 0, children: "\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9" }), _jsx("button", { onClick: copy, disabled: count === 0, children: "\u30B3\u30D4\u30FC" }), _jsxs("label", { style: { display: 'flex', alignItems: 'center', gap: '0.35rem', margin: 0 }, children: [_jsx("input", { type: "checkbox", checked: includeUnverified, onChange: (e) => setIncludeUnverified(e.target.checked), style: { width: 'auto' } }), "\u672A\u78BA\u8A8D\u3082\u542B\u3081\u308B"] })] }), _jsxs("p", { className: "hint", children: ["\u51FA\u529B\u5BFE\u8C61: ", count, " \u518A"] }), _jsx("textarea", { className: "preview", readOnly: true, value: content, "aria-label": "\u51FA\u529B\u30D7\u30EC\u30D3\u30E5\u30FC" })] }));
}
