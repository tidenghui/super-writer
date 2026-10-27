import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './index.ts';

/**
 * 根目录算错一次，后果是「每一本新书都启动失败」——
 * 而且日志里只写「找不到 config/models.json」，看起来像缺文件，不像算错路径。
 * 这条测试就是防止它再悄悄坏掉。
 */
test('项目根目录能定位到配置与书库', () => {
  assert.ok(existsSync(resolve(ROOT, 'config', 'models.json')), `找不到 ${resolve(ROOT, 'config', 'models.json')}`);
  assert.ok(existsSync(resolve(ROOT, 'books')), `找不到 ${resolve(ROOT, 'books')}`);
  assert.ok(existsSync(resolve(ROOT, 'packages', 'contract')), '根目录不是仓库根');
});
