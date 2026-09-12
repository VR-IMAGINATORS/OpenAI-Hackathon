import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
export interface GamePhoto {id:string;jpeg:Buffer}
export async function decodePhotos(images:string[],max:number):Promise<GamePhoto[]>{
 if(images.length>max)throw new Error('写真の枚数が上限を超えています。');
 return Promise.all(images.map(async value=>{
 if(value.length>2796204||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('写真形式が不正です。');
 const buffer=Buffer.from(value,'base64');if(!buffer.length||buffer.length>2*1024*1024)throw new Error('写真は2MiB以内にしてください。');
 const decoder=sharp(buffer,{limitInputPixels:16_000_000,animated:false});const meta=await decoder.metadata();
 if(!['jpeg','png','webp'].includes(meta.format??'')||(meta.pages??1)>1)throw new Error('JPEG/PNG/WebPの静止画を選んでください。');
 const jpeg=await decoder.rotate().resize({width:1280,height:1280,fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();
 if(jpeg.length>2*1024*1024)throw new Error('写真の変換結果が上限を超えています。');return{id:randomUUID(),jpeg};
 }));
}
