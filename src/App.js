import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adoptCandidate, entriesFromExtraction, runGoogleBooksStage, runNdlStage, runOpenBdStage, } from './pipeline/stages';
import { entriesFromIsbns } from './pipeline/stages';
import { extractSpines, isVlmConfigured } from './sources/vlm';
import { isNdlConfigured } from './sources/ndl';
import { loadSettings, saveSettings, listEntries, saveEntries, clearEntries } from './lib/db';
import { SettingsPanel } from './ui/SettingsPanel';
import { BookList } from './ui/BookList';
import { ExportPanel } from './ui/ExportPanel';
import { BarcodeScanner } from './ui/BarcodeScanner';
const INITIAL_STAGES = {
    extract: { status: 'idle' },
    googleBooks: { status: 'idle' },
    ndl: { status: 'idle' },
    openbd: { status: 'idle' },
};
/** 衝突しないID。crypto.randomUUID が無い環境向けの退避も持つ */
function newId() {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        return crypto.randomUUID();
    return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
export function App() {
    const [settings, setSettings] = useState(() => loadSettings());
    const [entries, setEntries] = useState([]);
    const [stages, setStages] = useState(INITIAL_STAGES);
    const [error, setError] = useState(null);
    // 既定はバーコード。APIキーが要らず課金も発生しないので、初見でも必ず動く
    const [inputMode, setInputMode] = useState('barcode');
    const [scanning, setScanning] = useState(false);
    const abortRef = useRef(null);
    // 起動時に前回の続きを復元する。段階を分けた以上、中断からの再開は必須
    useEffect(() => {
        listEntries()
            .then((loaded) => {
            if (loaded.length > 0)
                setEntries(loaded);
        })
            .catch(() => setError('保存済みデータの読み込みに失敗しました。'));
    }, []);
    const updateSettings = useCallback((next) => {
        setSettings(next);
        saveSettings(next);
    }, []);
    /** 変更を state と IndexedDB の両方に反映する */
    const commit = useCallback((next) => {
        setEntries(next);
        saveEntries(next).catch(() => setError('保存に失敗しました。'));
    }, []);
    const setStage = useCallback((id, patch) => {
        setStages((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    }, []);
    const makeContext = useCallback((id, controller) => ({
        signal: controller.signal,
        onProgress: (done, total) => setStage(id, { done, total }),
        settings: {
            ndlProxyUrl: settings.ndlProxyUrl,
            googleBooksCountry: settings.googleBooksCountry,
        },
    }), [settings.ndlProxyUrl, settings.googleBooksCountry, setStage]);
    /**
     * 段階を1つ実行する共通処理。
     * 各段階は独立して起動でき、失敗しても他の段階の成果は壊さない。
     */
    const runStage = useCallback(async (id, fn) => {
        setError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        setStage(id, { status: 'running', done: 0, total: entries.length, message: undefined });
        try {
            const next = await fn(makeContext(id, controller));
            commit(next);
            setStage(id, { status: 'done' });
        }
        catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                setStage(id, { status: 'idle', message: '中断しました' });
                return;
            }
            const message = err instanceof Error ? err.message : '不明なエラー';
            setStage(id, { status: 'error', message });
            setError(message);
        }
        finally {
            abortRef.current = null;
        }
    }, [entries.length, makeContext, commit, setStage]);
    // ── 段階0: 写真の取り込みと読み取り ──────────────────
    const onPickPhotos = useCallback(async (files) => {
        if (!files || files.length === 0)
            return;
        setError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        setStage('extract', { status: 'running', done: 0, total: files.length });
        const collected = [];
        try {
            for (let i = 0; i < files.length; i++) {
                const photoId = newId();
                const spines = await extractSpines(files[i], settings, controller.signal);
                collected.push(...entriesFromExtraction(photoId, spines, photoId));
                setStage('extract', { done: i + 1, total: files.length });
            }
            // 複数枚の撮影を重ねられるよう、既存の結果に足す
            commit([...entries, ...collected]);
            setStage('extract', { status: 'done' });
            // 抽出をやり直したら以降の段階は古くなる
            setStages((p) => ({
                ...p,
                googleBooks: { status: 'idle' },
                ndl: { status: 'idle' },
                openbd: { status: 'idle' },
            }));
        }
        catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                setStage('extract', { status: 'idle', message: '中断しました' });
                return;
            }
            const message = err instanceof Error ? err.message : '不明なエラー';
            setStage('extract', { status: 'error', message });
            setError(message);
        }
        finally {
            abortRef.current = null;
        }
    }, [entries, settings, commit, setStage]);
    // ── バーコードからの取り込み ──────────────────────────
    /** 既に一覧にある ISBN。スキャナ側の重複検知に渡す */
    const knownIsbns = useMemo(() => new Set(entries.map((e) => e.resolved?.isbn13).filter((v) => !!v)), [entries]);
    const onScanned = useCallback((isbns) => {
        setScanning(false);
        if (isbns.length === 0)
            return;
        setError(null);
        commit([...entries, ...entriesFromIsbns(isbns, newId())]);
        // ISBN は手に入ったが書誌はまだ空。照合段階を促すため done にはしない
        setStage('extract', { status: 'done' });
        setStages((p) => ({
            ...p,
            googleBooks: { status: 'idle' },
            ndl: { status: 'idle' },
            openbd: { status: 'idle' },
        }));
    }, [entries, commit, setStage]);
    // ── 手動操作 ────────────────────────────────────────
    const onAdopt = useCallback((entryId, candidate) => {
        commit(entries.map((e) => e.id === entryId
            ? // 手動で選んだものは pinned にして、以降の自動処理で上書きさせない
                { ...adoptCandidate(e, candidate), status: 'confirmed', pinned: true, conflicts: undefined }
            : e));
    }, [entries, commit]);
    const onExclude = useCallback((entryId) => {
        commit(entries.map((e) => (e.id === entryId ? { ...e, status: 'excluded' } : e)));
    }, [entries, commit]);
    const onRestore = useCallback((entryId) => {
        commit(entries.map((e) => e.id === entryId ? { ...e, status: e.resolved ? 'needsReview' : 'unverified' } : e));
    }, [entries, commit]);
    const onReset = useCallback(() => {
        clearEntries().catch(() => undefined);
        setEntries([]);
        setStages(INITIAL_STAGES);
        setError(null);
    }, []);
    const busy = Object.values(stages).some((s) => s.status === 'running');
    const ndlReady = isNdlConfigured(settings.ndlProxyUrl);
    const vlmReady = isVlmConfigured(settings);
    const hasIsbn = useMemo(() => entries.some((e) => e.resolved?.isbn13), [entries]);
    const stageDefs = [
        {
            id: 'extract',
            n: 1,
            title: inputMode === 'barcode' ? 'バーコードを読み取る' : '写真から背表紙を読み取る',
            desc: inputMode === 'barcode'
                ? 'カメラをバーコードにかざすだけで次々に読み取ります。APIキー不要・通信なし・課金なしで、誤読もほぼありません。'
                : vlmReady
                    ? '本棚の写真を選ぶと、背表紙のタイトル・著者を読み取ります。1段ずつ画面いっぱいに撮ると精度が上がります。'
                    : 'この方式にはAPIキーが必要です。設定を開いて登録するか、バーコード方式に切り替えてください。',
            action: inputMode === 'barcode' ? (_jsx("button", { className: "primary", disabled: busy, onClick: () => setScanning(true), children: "\u30AB\u30E1\u30E9\u3092\u8D77\u52D5" })) : (_jsxs("label", { className: "primary", style: { margin: 0 }, children: [_jsx("span", { style: {
                            display: 'inline-block',
                            padding: '0.45rem 0.9rem',
                            borderRadius: 7,
                            background: vlmReady && !busy ? 'var(--accent)' : 'var(--border)',
                            color: vlmReady && !busy ? '#fff' : 'var(--muted)',
                            cursor: vlmReady && !busy ? 'pointer' : 'not-allowed',
                            fontSize: '0.88rem',
                            fontWeight: 400,
                        }, children: "\u5199\u771F\u3092\u9078\u3076" }), _jsx("input", { type: "file", accept: "image/*", multiple: true, className: "visually-hidden", disabled: !vlmReady || busy, onChange: (e) => {
                            void onPickPhotos(e.target.files);
                            e.target.value = '';
                        } })] })),
        },
        {
            id: 'googleBooks',
            n: 2,
            title: 'Google Books で照合する',
            desc: '読み取った文字列を書誌データベースで照合し、実在が確認できたものを確定します。',
            action: (_jsx("button", { className: "primary", disabled: busy || entries.length === 0, onClick: () => void runStage('googleBooks', (ctx) => runGoogleBooksStage(entries, ctx)), children: "\u7167\u5408\u3059\u308B" })),
        },
        {
            id: 'ndl',
            n: 3,
            title: 'NDLサーチと突合する（任意）',
            desc: ndlReady
                ? '国立国会図書館サーチの結果と比較します。一次結果は上書きせず、差分の表示と欠けた項目の補完だけを行います。'
                : 'NDLサーチは CORS 非対応のため、設定でプロキシURLを登録すると使えるようになります。未設定でも他の機能は動きます。',
            action: (_jsx("button", { disabled: busy || !ndlReady || entries.length === 0, onClick: () => void runStage('ndl', (ctx) => runNdlStage(entries, ctx)), children: "\u7A81\u5408\u3059\u308B" })),
        },
        {
            id: 'openbd',
            n: 4,
            title: 'openBD で情報を補う（任意）',
            desc: 'ISBN が確定した本に、出版社・発売日・書影・内容紹介を補完します。',
            action: (_jsx("button", { disabled: busy || !hasIsbn, onClick: () => void runStage('openbd', (ctx) => runOpenBdStage(entries, ctx)), children: "\u88DC\u5B8C\u3059\u308B" })),
        },
    ];
    return (_jsxs("div", { className: "app", children: [_jsxs("header", { className: "masthead", children: [_jsx("h1", { children: "\u672C\u68DA\u30B9\u30AD\u30E3\u30CA" }), _jsx("p", { children: "\u672C\u68DA\u306E\u5199\u771F\u304B\u3089\u80CC\u8868\u7D19\u3092\u8AAD\u307F\u53D6\u308A\u3001\u66F8\u8A8C\u60C5\u5831\u3092\u691C\u7D22\u3057\u3066\u8535\u66F8\u4E00\u89A7\u3092\u4F5C\u308A\u307E\u3059\u3002" })] }), _jsx(SettingsPanel, { settings: settings, onChange: updateSettings }), error && _jsx("div", { className: "notice error", children: error }), _jsxs("div", { className: "modes", role: "group", "aria-label": "\u8AAD\u307F\u53D6\u308A\u65B9\u5F0F", children: [_jsxs("button", { className: "mode", "aria-pressed": inputMode === 'barcode', disabled: busy, onClick: () => setInputMode('barcode'), children: [_jsx("span", { className: "mode-title", children: "\u30D0\u30FC\u30B3\u30FC\u30C9" }), _jsx("span", { className: "mode-note", children: "\u8AB2\u91D1\u306A\u3057\u30FB\u9AD8\u7CBE\u5EA6\uFF0F1\u518A\u305A\u3064" })] }), _jsxs("button", { className: "mode", "aria-pressed": inputMode === 'spine', disabled: busy, onClick: () => setInputMode('spine'), children: [_jsx("span", { className: "mode-title", children: "\u80CC\u8868\u7D19\u306E\u5199\u771F" }), _jsx("span", { className: "mode-note", children: vlmReady ? '棚ごと一度に／APIキー必要' : 'APIキー未設定' })] })] }), scanning && (_jsx(BarcodeScanner, { knownIsbns: knownIsbns, onDone: onScanned, onCancel: () => setScanning(false) })), _jsx("div", { className: "stages", children: stageDefs.map((s) => {
                    const st = stages[s.id];
                    const pct = st.total ? Math.round(((st.done ?? 0) / st.total) * 100) : 0;
                    return (_jsxs("section", { className: "stage", "data-status": st.status, children: [_jsx("span", { className: "stage-num", children: st.status === 'done' ? '✓' : s.n }), _jsxs("div", { className: "stage-body", children: [_jsx("h2", { children: s.title }), _jsx("p", { children: st.message ?? s.desc }), st.status === 'running' && (_jsx("div", { className: "progress", children: _jsx("span", { style: { width: `${pct}%` } }) }))] }), _jsx("div", { className: "stage-actions", children: s.action })] }, s.id));
                }) }), busy && (_jsxs("div", { className: "notice info", children: ["\u5B9F\u884C\u4E2D\u2026", ' ', _jsx("button", { onClick: () => abortRef.current?.abort(), style: { marginLeft: '0.5rem' }, children: "\u4E2D\u6B62" })] })), _jsx("h2", { style: { fontSize: '1.05rem', marginTop: '2rem' }, children: "\u8AAD\u307F\u53D6\u3063\u305F\u672C" }), _jsx(BookList, { entries: entries, onAdopt: onAdopt, onExclude: onExclude, onRestore: onRestore }), entries.length > 0 && (_jsxs(_Fragment, { children: [_jsx("h2", { style: { fontSize: '1.05rem', marginTop: '2rem' }, children: "\u66F8\u8A8C\u4E00\u89A7\u3092\u51FA\u529B" }), _jsx(ExportPanel, { entries: entries }), _jsx("p", { style: { marginTop: '2rem' }, children: _jsx("button", { onClick: onReset, children: "\u3059\u3079\u3066\u6D88\u53BB\u3057\u3066\u3084\u308A\u76F4\u3059" }) })] }))] }));
}
