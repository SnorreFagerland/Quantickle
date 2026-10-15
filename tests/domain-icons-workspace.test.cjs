const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const appRoot = path.resolve(__dirname, '..');
const { JSDOM } = require(path.join(appRoot, 'node_modules/jsdom'));
const cytoscape = require(path.join(appRoot, 'node_modules/cytoscape'));

function setup(t, serverMode = 'online') {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        runScripts: 'dangerously', url: 'http://localhost:3000/'
    });
    const { window } = dom;
    t.after(() => window.close());
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.document.addEventListener = () => {};
    window.NodeTypes = { default: { color: '#ffffff', size: 30, shape: 'ellipse', icon: '' } };
    window.IconConfigs = {};
    const workspaceReads = [];
    const requests = [];
    window.WorkspaceManager = {
        handle: {},
        async readFile(asset) {
            workspaceReads.push(asset);
            return asset.endsWith('.png') ? new window.Blob(['old workspace PNG']) : null;
        },
        async saveFile() {}
    };
    window.URL.createObjectURL = () => 'blob:http://localhost:3000/old-workspace-icon';
    window.fetch = async (input, options) => {
        const url = new URL(input, window.location.href);
        requests.push({ url, options });
        if (serverMode === 'offline') throw new Error('Offline');
        const filename = path.join(appRoot, url.pathname);
        const exists = serverMode !== 'missing' && fs.existsSync(filename);
        const bytes = exists ? fs.readFileSync(filename) : Buffer.from('<html>fallback</html>');
        const isPng = exists && filename.endsWith('.png');
        return {
            ok: true, // Missing assets may hit the app's HTML fallback route.
            headers: { get: () => isPng ? 'image/png' : exists ? 'application/json' : 'text/html' },
            json: async () => JSON.parse(bytes.toString()),
            text: async () => bytes.toString(),
            blob: async () => new window.Blob([bytes]),
            bytes
        };
    };
    window.eval(fs.readFileSync(path.join(appRoot, 'js/domain-loader.js'), 'utf8'));
    const loader = window.DomainLoader;
    loader.ensureFsApi = () => true;
    loader.refreshUI = () => {};
    loader.saveState = () => {};
    return { window, loader, requests, workspaceReads, dom };
}

test('current server PNG takes precedence over an old workspace file and cached blob', async t => {
    const { loader, window, workspaceReads, requests } = setup(t);
    const asset = 'assets/domains/ai/fact.png';
    window.IconConfigs.ai_fact = asset;
    loader.iconUrlCache.set(asset, 'blob:http://localhost:3000/stale');
    loader.iconUrlCache.set('ai_fact', 'blob:http://localhost:3000/stale');
    const resolved = await loader.resolveIcon('ai_fact');
    assert.ok(resolved.startsWith('/assets/domains/ai/fact.png?'), resolved);
    assert.equal(loader.getIconProxyUrl(asset), resolved);
    assert.equal(loader.getIconProxyUrl('ai_fact'), resolved);
    assert.equal(workspaceReads.length, 0, 'Server asset should bypass the old workspace PNG');
    assert.equal(requests[0].options.cache, 'reload');
    await Promise.all([loader.resolveIcon(asset), loader.resolveIcon('ai_fact')]);
    assert.equal(requests.length, 1, 'Repeated icon resolutions should share one server request');
    const png = await window.fetch(resolved);
    assert.deepEqual(png.bytes, fs.readFileSync(path.join(appRoot, asset)));
});

test('supplied QUT graph renders current domain PNGs through loader, renderer and node editor', async t => {
    const { window, loader, workspaceReads } = setup(t);
    window.eval(fs.readFileSync(path.join(appRoot, 'js/features/file-manager/file-manager-module.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(appRoot, 'js/graph.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(appRoot, 'js/features/node-editor/node-editor-module.js'), 'utf8'));
    window.Image = undefined;
    const fm = new window.FileManagerModule({ cytoscape: null, notifications: { show() {} } });
    const raw = JSON.parse(fs.readFileSync(path.join(appRoot, 'CAIRN-1-proj_001-5967.qut'), 'utf8'));
    const graph = fm.prepareGraphData(raw);
    const types = [...new Set(graph.nodes.map(node => node.type))];
    loader.defaultNodeTypes = { default: window.NodeTypes.default };
    loader.defaultIconConfigs = {};
    loader.availableDomains = {
        default: { loaded: true, types: loader.defaultNodeTypes },
        ai: { loaded: false, files: types.map(type => `assets/domains/ai/${type}.json`) }
    };
    for (const type of types) loader.recordTypeMapping('ai', type);
    await loader.autoLoadDomainsForGraph(graph);
    const renderer = window.GraphRenderer;
    const elements = graph.nodes.map(node => ({ data: { ...node } }));
    for (const element of elements) renderer.normalizeNodeData(element);
    const cy = cytoscape({ headless: true, styleEnabled: true, elements });
    t.after(() => cy.destroy());
    renderer.cy = cy;
    for (const node of cy.nodes()) {
        window.NodeEditorModule.prototype.applyIconStyle.call({ notifications: { show() {} } }, node, node.data('icon'));
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cy.nodes().length, 28);
    for (const node of cy.nodes()) {
        assert.match(node.data('backgroundImage'), /^url\("\/assets\/domains\/ai\/[^?]+\.png\?iconVersion=/);
        assert.ok(!node.style('background-image').includes('blob:'), node.id());
    }
    assert.equal(workspaceReads.filter(asset => asset.endsWith('.png')).length, 0);
    // Normalizing graph icons must still preserve user-specified icon URLs.
    const custom = { data: { id: 'custom', type: 'ai_fact', icon: 'https://example.test/custom.png' } };
    renderer.normalizeNodeData(custom);
    assert.equal(custom.data.icon, 'https://example.test/custom.png');
});

for (const mode of ['offline', 'missing']) {
    test(`workspace-only domain icons still work when server is ${mode}`, async t => {
        const { loader, workspaceReads } = setup(t, mode);
        const result = await loader.resolveIcon('assets/domains/custom/local.png');
        assert.match(result, /^blob:/);
        assert.equal(workspaceReads.length, 1);
    });
}

test('Reload all clears resolved icon URLs and requests a new asset version', async t => {
    const { loader } = setup(t);
    const asset = 'assets/domains/ai/fact.png';
    const before = await loader.resolveIcon(asset);
    loader.moveLocalConfigFilesToTmp = async () => {};
    loader.invalidateAllDomainCaches = () => {};
    loader.refreshLocalConfigFiles = async () => {};
    loader.fetchAvailableDomains = async () => {};
    loader.availableDomains = { default: { loaded: true } };
    loader.rebuildActiveConfiguration = () => {};
    loader.storeDomainCache = () => {};
    await loader.forceReloadAllDomains();
    const after = await loader.resolveIcon(asset);
    assert.notEqual(after, before, 'Reload all must invalidate resolved image URLs');
});
