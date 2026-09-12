export interface PreparedPhoto { base64: string; preview: string }
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選択してください。');
  if (file.size > 32 * 1024 * 1024) throw new Error('写真が大きすぎます。32MB以下の写真を選択してください。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('このブラウザでは写真を処理できません。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL('image/jpeg', 0.82);
    const base64 = preview.slice(preview.indexOf(',') + 1);
    if (base64.length > 2_796_204) throw new Error('写真を小さくして再度撮影してください。');
    canvas.width = canvas.height = 0;
    return { preview, base64 };
  } catch (error) {
    if (error instanceof Error && error.name !== 'EncodingError') throw error;
    throw new Error('写真を読み込めません。JPEG、PNGなどの画像で再試行してください。');
  } finally { URL.revokeObjectURL(url); }
}