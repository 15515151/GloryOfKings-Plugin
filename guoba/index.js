/**
 * 营地消息 —— 旧锅巴（CustomPageService / `PAGE_DIRS`）的 `guoba/` 入口。
 *
 * ## 它现在只是个转发
 * 页面/接口注册的唯一实现在 `webadapter/index.js`（新锅巴扫描的目录）。
 * ⚠️ 之所以把实现放 webadapter/ 而不是这里：锅巴「重新扫描」时用
 *    `import('...?t=时间戳')` 重载的是**入口文件本身**，只有入口在 webadapter/
 *    才改完即生效；实现留在 guoba/ 再被转出的话，重扫读到的是被缓存的老模块，
 *    必须重启进程。
 *
 * ## 资源各放各的
 * `init` 里的 `src: 'page.html'` / `style: 'page.css'` 由锅巴按**加载它的目录**
 * 解析，所以旧锅巴从本目录加载时用的是 `guoba/page.html` / `guoba/page.css`。
 */
export { init } from '../webadapter/index.js'
