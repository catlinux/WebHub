const { chromium } = require('playwright');
// Prueba de extremo a extremo en Chromium real. Uso: test/e2e/ejecutar.sh
// Requiere Playwright instalado aparte (no es dependencia del proyecto).
const path = require('path');
const OUT = process.argv[2];
const BASE = process.env.WEBHUB_URL ?? 'http://127.0.0.1:3100';
const PASSWORD = process.env.WEBHUB_PASSWORD ?? 'demo-clave-larga-123';
const DEMO = path.join(__dirname, 'demo-marcadores.html');
require('fs').mkdirSync(`${OUT}/capturas`, { recursive: true });
const shot = (page, name) => page.screenshot({ path: `${OUT}/capturas/${name}.png` });
const ok = (cond, msg) => { if (!cond) throw new Error('FALLO: ' + msg); console.log('✔', msg); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, body: 'externo' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|401|400/.test(m.text())) errors.push(m.text()); });

  await page.goto(BASE + '/');
  await page.waitForSelector('.login input[type=password]');
  await page.fill('.login input', 'incorrecta');
  await page.click('.login button');
  await page.waitForSelector('.login .error:has-text("incorrecta")');
  ok(true, 'contraseña incorrecta muestra error');
  await shot(page, '01-login');
  await page.fill('.login input', PASSWORD);
  await page.click('.login button');
  await page.waitForSelector('.layout');
  ok(await page.isVisible('text=Todavía no hay enlaces'), 'estado vacío tras login');
  const cookies = await ctx.cookies();
  const c = cookies.find((x) => x.name === 'webhub_sesion');
  ok(c && c.httpOnly && c.sameSite === 'Strict', 'cookie httpOnly + SameSite=Strict');

  // Importar marcadores
  await page.click('text=Importar marcadores del navegador');
  await page.setInputFiles('input[type=file]', DEMO);
  await page.waitForSelector('text=Vista previa');
  const btnText = await page.textContent('button.primario:has-text("Importar")');
  ok(/Importar 48 enlaces/.test(btnText), 'vista previa: ' + btnText.trim());
  await page.click('details.grupo-import:has-text("Interés") summary .nombre');
  await shot(page, '02-importar-vista-previa');
  await page.click('button.primario:has-text("Importar")');
  await page.waitForSelector('.columnas');
  ok((await page.locator('a.link').count()) === 48, '48 enlaces visibles en Todos');
  await page.waitForTimeout(300);
  await shot(page, '03-todos');

  // Todos los enlaces abren pestaña nueva con rel seguro
  const bad = await page.$$eval('a.link', (as) => as.filter((a) => a.target !== '_blank' || a.rel !== 'noopener noreferrer').length);
  ok(bad === 0, 'todos los enlaces con target=_blank y rel="noopener noreferrer"');

  // Familia con subfamilias
  await page.click('.nav-item:has-text("Proveedores")');
  await page.waitForSelector('h2:has-text("Proveedores")');
  ok((await page.textContent('.barra .contador')).includes('12'), 'Proveedores cuenta 12 (incluye subfamilias)');
  await shot(page, '04-familia');

  // Búsqueda con Ctrl+K y teclado
  await page.keyboard.press('Control+k');
  ok(await page.evaluate(() => document.activeElement.type === 'search'), 'Ctrl+K enfoca la búsqueda');
  await page.keyboard.type('cloud');
  await page.waitForSelector('h2:has-text("Buscar")');
  const titles = await page.$$eval('a.link .titulo', (els) => els.map((e) => e.textContent));
  ok(titles[0] === 'Cloudflare' && titles.includes('Hetzner Cloud') && titles.includes('Nextcloud'), 'resultados: ' + titles.join(', '));
  await shot(page, '05-busqueda');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement.querySelector('.titulo')?.textContent);
  ok(focused === titles[1], 'flechas mueven el foco: ' + focused);
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.keyboard.press('Enter')]);
  ok(!!popup, 'Enter abre el enlace en una pestaña nueva');
  await popup.close();
  // búsqueda por etiqueta/nota: añadimos una nota a un enlace
  await page.keyboard.press('Escape'); // vuelve al buscador
  await page.keyboard.press('Escape'); // limpia
  ok((await page.inputValue('input[type=search]')) === '', 'Escape limpia la búsqueda');

  // Más clics para favoritos
  await page.goto(BASE + '/#/todos');
  await page.waitForSelector('a.link');
  for (const t of ['GitHub', 'GitHub', 'Grafana', 'LWN.net']) {
    const [p] = await Promise.all([ctx.waitForEvent('page'), page.click(`a.link:has(.titulo:text-is(\"${t}\"))`)]);
    await p.close();
  }
  await page.hover('a.link:has(.titulo:text-is("Cloudflare"))');
  await page.click('li.fila:has(.titulo:text-is("Cloudflare")) .estrella');
  await page.waitForTimeout(300);
  await page.click('.nav-item:has-text("Favoritos")');
  await page.waitForSelector('h3:has-text("Más usados")');
  const top = await page.$$eval('.bloque:has(h3:has-text("Más usados")) .titulo', (els) => els.map((e) => e.textContent));
  ok(top[0] === 'GitHub', 'más usados: ' + top.join(', '));
  ok(await page.isVisible('.bloque:has(h3:has-text("Favoritos")) .titulo:text-is("Cloudflare")'), 'Cloudflare en favoritos');
  await shot(page, '06-favoritos');

  // Recarga: los clics persisten en el servidor
  await page.reload();
  await page.waitForSelector('h3:has-text("Más usados")');
  ok(true, 'favoritos y clics persisten tras recargar');

  // Administración: organizar
  await page.click('text=⚙ Administrar');
  await page.waitForSelector('.organizar');
  await page.click('.fila-admin .texto:text-is("Redes")');
  await page.waitForSelector('h3:has-text("Enlaces de «Redes»")');
  await shot(page, '07-admin-organizar');
  // Reordenar arrastrando: Telegram Web antes de Mastodon
  await page.dragAndDrop('.panel:nth-child(2) .fila-admin:has-text("Telegram Web") .asa', '.panel:nth-child(2) .fila-admin:has-text("Mastodon")', { targetPosition: { x: 20, y: 3 } });
  await page.waitForTimeout(500);
  const order = await page.$$eval('.panel:nth-child(2) .fila-admin .texto', (els) => els.map((e) => e.firstChild.textContent + (e.childNodes[1]?.textContent ?? '')).slice(0, 2));
  ok(/Telegram/.test(order[0]), 'arrastrar reordena enlaces: ' + order.join(' | '));
  // Mover enlace a otra familia arrastrando sobre ella
  await page.dragAndDrop('.panel:nth-child(2) .fila-admin:has-text("Reddit") .asa', '.panel:first-child .fila-admin:has-text("Interés")');
  await page.waitForTimeout(500);
  ok(!(await page.isVisible('.panel:nth-child(2) .fila-admin:has-text("Reddit")')), 'Reddit movido fuera de Redes');
  // Reordenar familias arrastrando: Interés antes de Proveedores
  await page.dragAndDrop('.panel:first-child .fila-admin:has-text("Interés") .asa', '.panel:first-child .fila-admin:not(.sub):has-text("Proveedores")', { targetPosition: { x: 20, y: 3 } });
  await page.waitForTimeout(500);
  const fams = await page.$$eval('.nav-item:not(.sub) .nombre', (els) => els.map((e) => e.textContent));
  ok(fams[2] === 'Interés', 'familias reordenadas: ' + fams.join(', '));

  // Editar enlace con notas y etiquetas
  await page.click('.panel:nth-child(2) .fila-admin:has-text("GitHub") .texto');
  await page.waitForSelector('dialog[open]');
  await page.fill('dialog input[placeholder="separadas por comas"]', 'código, repos');
  await page.fill('dialog input[placeholder^="Nota"]', 'cuenta principal');
  await shot(page, '08-editar-enlace');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('dialog', { state: 'detached' });
  // URL peligrosa rechazada
  await page.click('.panel:nth-child(2) button:has-text("+ Enlace")');
  await page.fill('dialog input[inputmode=url]', 'javascript:alert(1)');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('dialog .error:has-text("no es válida")');
  ok(true, 'javascript: rechazado en el formulario');
  await page.click('dialog button:has-text("Cancelar")');

  // Buscar por etiqueta y nota
  await page.fill('input[type=search]', 'repos');
  await page.waitForSelector('a.link .titulo:text-is("GitHub")');
  await page.fill('input[type=search]', 'principal');
  await page.waitForSelector('a.link .nota:text-is("cuenta principal")');
  ok(true, 'búsqueda por etiqueta y por nota');
  await shot(page, '09-busqueda-nota');
  await page.fill('input[type=search]', '');

  // Copia de seguridad
  await page.goto(BASE + '/#/admin/copia');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Descargar copia (JSON)')]);
  const copia = `${OUT}/copia.json`;
  await dl.saveAs(copia);
  const json = JSON.parse(require('fs').readFileSync(copia, 'utf8'));
  ok(json.app === 'WebHub' && json.links.length === 48, 'copia descargada: ' + dl.suggestedFilename());
  await page.setInputFiles('input[type=file]', copia);
  await page.waitForSelector('text=Sustituir todo por esta copia');
  await shot(page, '10-copia');

  // Comprobador (aquí la red externa del servidor no está disponible)
  await page.goto(BASE + '/#/admin/comprobar');
  await page.click('button:has-text("Comprobar los")');
  await page.waitForSelector('text=Última comprobación', { timeout: 60000 });
  await page.waitForTimeout(500);
  await shot(page, '11-comprobador');

  // Móvil
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.addCookies(await ctx.cookies());
  await m.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, body: 'externo' }));
  const mp = await m.newPage();
  await mp.goto(BASE + '/#/todos');
  await mp.waitForSelector('a.link');
  ok(!(await mp.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right > 0)), 'móvil: barra lateral plegada');
  await mp.screenshot({ path: `${OUT}/capturas/12-movil.png` });
  await mp.click('.menu-btn');
  await mp.waitForTimeout(300);
  await mp.screenshot({ path: `${OUT}/capturas/13-movil-menu.png` });
  await mp.click('.nav-item:has-text("Mis webs")');
  await mp.waitForTimeout(300);
  ok(await mp.isVisible('h2:has-text("Mis webs")'), 'móvil: elegir familia cierra el menú y la muestra');

  // Cerrar sesión
  await page.goto(BASE + '/#/todos');
  await page.click('text=Salir');
  await page.waitForSelector('.login');
  const r = await page.evaluate(() => fetch('/api/data').then((x) => x.status));
  ok(r === 401, 'tras salir, la API responde 401');

  ok(errors.length === 0, 'sin errores de JavaScript en consola' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
