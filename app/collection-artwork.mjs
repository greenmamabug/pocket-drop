// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dimensions } from './artwork.mjs';

function checkedImage(nativeImage, bytes) {
  const size = dimensions(bytes);
  if (!size || size.width * size.height > 50_000_000)
    throw new Error('Choose a readable image with fewer than 50 million pixels.');
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('This collection picture cannot be read.');
  return image;
}
function crop(image, width, height) {
  const size = image.getSize(),
    scale = Math.max(width / size.width, height / size.height);
  const resized = image.resize({
    width: Math.max(width, Math.round(size.width * scale)),
    height: Math.max(height, Math.round(size.height * scale)),
    quality: 'best',
  });
  const bounds = resized.getSize();
  return resized.crop({
    x: Math.floor((bounds.width - width) / 2),
    y: Math.floor((bounds.height - height) / 2),
    width,
    height,
  });
}
async function store(editor, folder, image) {
  await fs.mkdir(path.join(folder, 'artwork'), { recursive: true });
  const ref = 'asset:' + randomUUID() + '.png';
  await fs.writeFile(editor.asset(ref), image.toPNG(), { flag: 'wx' });
  return ref;
}
export async function makeCollectionPicture({ nativeImage, editor, folder }, bytes, iconBytes) {
  const image = checkedImage(nativeImage, bytes),
    square = crop(image, 256, 256),
    card = crop(image, 252, 400);
  const icon = iconBytes ? checkedImage(nativeImage, iconBytes) : square;
  return {
    ref: await store(editor, folder, square),
    iconRef: await store(editor, folder, icon.resize({ width: 16, height: 16, quality: 'best' })),
    imageRef: await store(editor, folder, card),
    thumbnail: square.resize({ width: 128, height: 128, quality: 'best' }).toDataURL(),
    cardThumbnail: card.resize({ width: 126, height: 200, quality: 'best' }).toDataURL(),
  };
}
export async function checkedCollectionPicture(
  { nativeImage, editor, folder },
  picture,
  { needCard = false } = {},
) {
  const refs = [picture.ref, picture.iconRef, ...(picture.imageRef ? [picture.imageRef] : [])];
  for (const ref of refs) {
    const stat = await fs.lstat(editor.asset(ref));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 2)
      throw new Error('Choose a collection picture using Change picture.');
  }
  const image = checkedImage(nativeImage, await fs.readFile(editor.asset(picture.ref)));
  const saved = {
    ref: picture.ref,
    iconRef: picture.iconRef,
    thumbnail: crop(image, 128, 128).toDataURL(),
  };
  if (picture.imageRef || needCard) {
    const card = picture.imageRef
      ? checkedImage(nativeImage, await fs.readFile(editor.asset(picture.imageRef)))
      : crop(image, 252, 400);
    const bounds = card.getSize();
    if (bounds.width !== 252 || bounds.height !== 400)
      throw new Error('The collection card must be 252 × 400 pixels. Choose the picture again.');
    saved.imageRef = picture.imageRef ?? (await store(editor, folder, card));
    saved.cardThumbnail = card.resize({ width: 126, height: 200, quality: 'best' }).toDataURL();
  }
  return saved;
}
