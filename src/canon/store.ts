/**
 * 转发层。
 *
 * 真正的实现已经搬到 packages/contract：那是阅读器和写手共用的契约。
 * 这里保留一层转发，是为了让现有 import 不用一次性全改。
 * 新代码请直接从 contract 引入。
 */
export * from '../../packages/contract/src/index.ts';
