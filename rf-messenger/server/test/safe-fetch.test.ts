import { describe, expect, it } from 'vitest';
import { assertPublicUrl } from '../src/safe-fetch.ts';

const dns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];

describe('assertPublicUrl: защита от внутренних адресов', () => {
  const resolve = dns({
    'do-mediaout-max.fra1.digitaloceanspaces.com': ['10.110.15.254'],
    'evil.digitaloceanspaces.com': ['127.0.0.1'],
    'meta.digitaloceanspaces.com': ['169.254.169.254'],
    'lan.digitaloceanspaces.com': ['192.168.1.5'],
    'digitaloceanspaces.com.evil.ru': ['10.0.0.5'],
    'internal.example.com': ['10.0.0.5'],
    'cdn.example.com': ['93.184.216.34'],
  });

  it('публичный адрес — можно, внутренний — нельзя', async () => {
    await expect(assertPublicUrl('https://cdn.example.com/a.jpg', resolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://internal.example.com/a.jpg', resolve)).rejects.toThrow('внутреннюю сеть');
    await expect(assertPublicUrl('http://10.0.0.5/a.jpg', resolve)).rejects.toThrow('внутреннюю сеть');
  });

  it('хранилище DigitalOcean Spaces (медиа MAX через GREEN-API): внутренний 10.x изнутри облака — можно, только по https', async () => {
    await expect(assertPublicUrl('https://do-mediaout-max.fra1.digitaloceanspaces.com/x/photo.jpg?sig=1', resolve)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://do-mediaout-max.fra1.digitaloceanspaces.com/x/photo.jpg', resolve)).rejects.toThrow('внутреннюю сеть');
  });

  it('исключение не открывает localhost, метаданные облака, 192.168 и чужие домены с похожим именем', async () => {
    await expect(assertPublicUrl('https://evil.digitaloceanspaces.com/a', resolve)).rejects.toThrow('внутреннюю сеть');
    await expect(assertPublicUrl('https://meta.digitaloceanspaces.com/a', resolve)).rejects.toThrow('внутреннюю сеть');
    await expect(assertPublicUrl('https://lan.digitaloceanspaces.com/a', resolve)).rejects.toThrow('внутреннюю сеть');
    await expect(assertPublicUrl('https://digitaloceanspaces.com.evil.ru/a', resolve)).rejects.toThrow('внутреннюю сеть');
  });
});
