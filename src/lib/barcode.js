/**
 * ISBN バーコードの読み取り
 *
 * 背表紙OCRと違い、バーコードは誤読がほぼ無く、通信も課金も発生しない。
 * 「課金ゼロで確実に蔵書リストを作る」経路の中核。
 *
 * ── 検出器の二本立て ──────────────────────────────────
 * BarcodeDetector はブラウザ内蔵で高速だが Safari が非対応。
 * 非対応環境では zxing-wasm を遅延ロードして代替する。
 * wasm は初回スキャン時まで読み込まないので、初期表示は重くならない。
 */
import { isValidIsbn13 } from './isbn';
/**
 * 日本の書籍は2段バーコードで、
 *   上段 = 978/979 で始まる ISBN
 *   下段 = 192... で始まる分類・価格コード
 * の2本が並んでいる。下段を本のIDとして拾うと存在しない書誌を引くため、
 * 「978/979 で始まり ISBN-13 のチェックディジットが合うもの」だけを通す。
 *
 * isbn.ts の extractIsbn13 は使わない。あちらは文字列中から10桁ISBNも
 * 拾おうとするため、下段の 13桁コードの部分列がたまたま ISBN-10 として
 * 成立してしまう危険がある。バーコードでは厳密一致で十分。
 */
export function isIsbnBarcode(raw) {
    const v = raw.replace(/[\s-]/g, '');
    if (!/^97[89]\d{10}$/.test(v))
        return false;
    return isValidIsbn13(v);
}
/** 検出された複数のコードから ISBN を1つ選ぶ。無ければ null */
export function pickIsbn13(codes) {
    for (const c of codes) {
        const v = c.replace(/[\s-]/g, '');
        if (isIsbnBarcode(v))
            return v;
    }
    return null;
}
function nativeCtor() {
    return globalThis.BarcodeDetector;
}
/** 内蔵 BarcodeDetector が EAN-13 を読めるか */
export async function hasNativeDetector() {
    const Ctor = nativeCtor();
    if (!Ctor)
        return false;
    try {
        return (await Ctor.getSupportedFormats()).includes('ean_13');
    }
    catch {
        return false;
    }
}
async function createNativeReader() {
    const Ctor = nativeCtor();
    const detector = new Ctor({ formats: ['ean_13'] });
    return {
        kind: 'native',
        async detect(image) {
            return (await detector.detect(image)).map((b) => b.rawValue);
        },
    };
}
async function createWasmReader() {
    // 遅延ロード。ここで初めて wasm を取りに行く
    const [{ prepareZXingModule, readBarcodes }, wasmUrl] = await Promise.all([
        import('zxing-wasm/reader'),
        // Vite に wasm を資産として配置させ、その URL を得る。
        // これをしないと zxing-wasm は CDN を見に行き、オフラインで壊れる
        import('zxing-wasm/reader/zxing_reader.wasm?url').then((m) => m.default),
    ]);
    prepareZXingModule({ overrides: { locateFile: () => wasmUrl } });
    return {
        kind: 'wasm',
        async detect(image) {
            const results = await readBarcodes(image, { formats: ['EAN-13'], tryHarder: true });
            return results.filter((r) => r.isValid !== false).map((r) => r.text);
        },
    };
}
/**
 * 使える検出器を作る。内蔵を優先し、駄目なら wasm。
 * wasm のロードに失敗した場合は例外を投げる(呼び出し側でUI表示する)。
 */
export async function createBarcodeReader() {
    if (await hasNativeDetector())
        return createNativeReader();
    return createWasmReader();
}
// ── カメラ ────────────────────────────────────────────
export class CameraUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CameraUnavailableError';
    }
}
/**
 * 背面カメラを開く。
 *
 * getUserMedia はセキュアコンテキスト(HTTPS または localhost)でしか動かない。
 * LAN の開発サーバ(素の http)では必ずここで失敗するので、
 * 原因が分かるメッセージにしておく。
 */
export async function openRearCamera() {
    if (!globalThis.isSecureContext) {
        throw new CameraUnavailableError('カメラは HTTPS でのみ利用できます。公開URL(https://)から開いてください。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new CameraUnavailableError('このブラウザはカメラ入力に対応していません。');
    }
    try {
        return await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 },
            },
            audio: false,
        });
    }
    catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError') {
            throw new CameraUnavailableError('カメラの使用が許可されませんでした。ブラウザの設定で許可してください。');
        }
        if (name === 'NotFoundError') {
            throw new CameraUnavailableError('カメラが見つかりませんでした。');
        }
        throw new CameraUnavailableError('カメラを開けませんでした。');
    }
}
/**
 * 映像の中央帯だけを ImageData として切り出す。
 *
 * バーコードは画面中央にかざされるので、周辺を捨てると
 * 検出が速くなり、隣の本を誤って読む事故も減る。
 */
export function grabCenterBand(video, canvas, bandRatio = 0.45) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh)
        return null;
    const bandH = Math.max(1, Math.round(vh * bandRatio));
    const sy = Math.round((vh - bandH) / 2);
    canvas.width = vw;
    canvas.height = bandH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx)
        return null;
    ctx.drawImage(video, 0, sy, vw, bandH, 0, 0, vw, bandH);
    return ctx.getImageData(0, 0, vw, bandH);
}
