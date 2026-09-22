import { renderSVG } from 'uqr';

const QR_PX = 192;

export function qrSvg(text: string): string {
	const raw = renderSVG(text, { ecc: 'M', border: 2 });
	return raw.replace('<svg ', `<svg width="${QR_PX}" height="${QR_PX}" `);
}
