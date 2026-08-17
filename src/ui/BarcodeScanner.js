import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraUnavailableError, createBarcodeReader, grabCenterBand, openRearCamera, pickIsbn13, } from '../lib/barcode';
/** 検出を試みる間隔。毎フレーム回すと wasm 経路で発熱するだけで精度は上がらない */
const SCAN_INTERVAL_MS = 140;
/** 読み取り成功の合図を出す。端末が対応していないものは黙って飛ばす */
function signalHit() {
    try {
        navigator.vibrate?.(60);
    }
    catch {
        /* iOS は未対応。無視してよい */
    }
}
/**
 * ISBN バーコードの連続スキャン。
 *
 * 本を「かざすだけ」で次々に読めることを狙っている。
 * シャッターを押させると1冊ごとに手が止まり、棚卸しの速度が出ない。
 */
export function BarcodeScanner({ knownIsbns, onDone, onCancel }) {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    /** このセッションで読んだ ISBN。描画のたびに作り直さないよう ref で持つ */
    const scannedRef = useRef(new Set());
    const [scanned, setScanned] = useState([]);
    const [error, setError] = useState(null);
    const [ready, setReady] = useState(false);
    const [readerKind, setReaderKind] = useState(null);
    /** 直近の読み取り結果。既出かどうかで表示を変える */
    const [flash, setFlash] = useState(null);
    const handleCode = useCallback((isbn) => {
        const dup = scannedRef.current.has(isbn) || knownIsbns.has(isbn);
        if (!dup) {
            scannedRef.current.add(isbn);
            setScanned((prev) => [...prev, isbn]);
        }
        signalHit();
        setFlash({ isbn, dup, at: Date.now() });
    }, [knownIsbns]);
    useEffect(() => {
        let cancelled = false;
        let stream = null;
        let timer;
        const start = async () => {
            let reader;
            try {
                // カメラ許可の確認と wasm のロードは同時に進める
                const [s, r] = await Promise.all([openRearCamera(), createBarcodeReader()]);
                stream = s;
                reader = r;
            }
            catch (err) {
                if (cancelled)
                    return;
                setError(err instanceof CameraUnavailableError
                    ? err.message
                    : 'バーコード読み取りを開始できませんでした。');
                return;
            }
            // 待っている間にアンマウントされていたらカメラを手放す
            if (cancelled) {
                stream.getTracks().forEach((t) => t.stop());
                return;
            }
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas) {
                stream.getTracks().forEach((t) => t.stop());
                return;
            }
            video.srcObject = stream;
            try {
                await video.play();
            }
            catch {
                // 自動再生が拒否されても playsInline なら大抵は描画される。続行する
            }
            if (cancelled)
                return;
            setReaderKind(reader.kind);
            setReady(true);
            const tick = async () => {
                if (cancelled)
                    return;
                const image = grabCenterBand(video, canvas);
                if (image) {
                    try {
                        const isbn = pickIsbn13(await reader.detect(image));
                        if (isbn && !cancelled)
                            handleCode(isbn);
                    }
                    catch {
                        // 1フレームの失敗で走査を止めない
                    }
                }
                if (!cancelled)
                    timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS);
            };
            void tick();
        };
        void start();
        return () => {
            cancelled = true;
            clearTimeout(timer);
            stream?.getTracks().forEach((t) => t.stop());
        };
    }, [handleCode]);
    // 読み取り表示を一定時間で消す
    useEffect(() => {
        if (!flash)
            return;
        const t = setTimeout(() => setFlash(null), 1200);
        return () => clearTimeout(t);
    }, [flash]);
    if (error) {
        return (_jsxs("div", { className: "scanner", children: [_jsx("div", { className: "notice error", children: error }), _jsx("div", { className: "scanner-actions", children: _jsx("button", { onClick: onCancel, children: "\u623B\u308B" }) })] }));
    }
    return (_jsxs("div", { className: "scanner", children: [_jsxs("div", { className: "scanner-view", children: [_jsx("video", { ref: videoRef, playsInline: true, muted: true, autoPlay: true }), _jsx("div", { className: "scanner-band", "data-hit": flash ? (flash.dup ? 'dup' : 'new') : undefined }), !ready && _jsx("p", { className: "scanner-status", children: "\u30AB\u30E1\u30E9\u3092\u6E96\u5099\u3057\u3066\u3044\u307E\u3059\u2026" }), flash && (_jsx("p", { className: "scanner-toast", "data-dup": flash.dup, children: flash.dup ? `読み取り済み: ${flash.isbn}` : `${flash.isbn}` }))] }), _jsx("canvas", { ref: canvasRef, className: "visually-hidden" }), _jsxs("p", { className: "hint", children: ["\u672C\u306E\u88CF\u8868\u7D19\u306E\u30D0\u30FC\u30B3\u30FC\u30C9\u3092\u67A0\u306B\u91CD\u306D\u3066\u304F\u3060\u3055\u3044\u3002\u4E0A\u6BB5\uFF08978\u3067\u59CB\u307E\u308B\u65B9\uFF09\u3092\u8AAD\u307F\u307E\u3059\u3002", readerKind === 'wasm' && ' ／ このブラウザでは互換モードで読み取っています。'] }), _jsxs("div", { className: "scanner-count", children: [_jsx("strong", { children: scanned.length }), " \u518A\u8AAD\u307F\u53D6\u308A", scanned.length > 0 && (_jsxs("span", { className: "scanner-recent", children: [scanned.slice(-3).reverse().join(' / '), scanned.length > 3 && ' …'] }))] }), _jsxs("div", { className: "scanner-actions", children: [_jsxs("button", { className: "primary", disabled: scanned.length === 0, onClick: () => onDone(scanned), children: ["\u8AAD\u307F\u53D6\u308A\u3092\u7D42\u3048\u308B\uFF08", scanned.length, "\u518A\uFF09"] }), _jsx("button", { onClick: onCancel, children: "\u3084\u3081\u308B" })] })] }));
}
