/************************************************************************
 * HostBridge - Thin abstraction over the VS Code webview messaging API. *
 *                                                                       *
 * The simulator runs in two places: inside a VS Code webview panel and  *
 * as a plain page in a browser. Everything that needs the extension     *
 * host (config injection, saving renderMap.json) goes through here so   *
 * the rest of the code stays identical in both environments.            *
 *                                                                       *
 * In the browser the API is absent and every call degrades to a no-op,  *
 * leaving the original web behavior in place.                           *
 ***********************************************************************/
var HostBridge = (function () {

    var api = null;
    // Null prototype: command lookup cannot see Object.prototype methods
    // such as constructor or toString. Only names registered with on() exist.
    var handlers = Object.create(null);

    // acquireVsCodeApi exists only inside a webview, and may be called
    // exactly once per page load
    if (typeof acquireVsCodeApi === 'function') {
        try {
            api = acquireVsCodeApi();
        } catch (e) {
            api = null;
        }
    }

    if (api) {
        window.addEventListener('message', function (event) {
            var message = event.data;
            if (!message || typeof message.command !== 'string') return;
            // Allow-list: only an own property registered via on(), and only
            // when that property is a function.
            var command = message.command;
            if (!Object.prototype.hasOwnProperty.call(handlers, command)) return;
            var fn = handlers[command];
            if (typeof fn === 'function') fn(message);
        });
    }

    /**
     * True when running inside the VS Code webview panel.
     */
    function isHosted() {
        return api !== null;
    }

    /**
     * Send a message to the extension host. No-op in the browser.
     */
    function post(message) {
        if (api) api.postMessage(message);
    }

    /**
     * Register a handler for a command sent by the extension host.
     */
    function on(command, fn) {
        if (typeof command !== 'string' || typeof fn !== 'function') return;
        handlers[command] = fn;
    }

    /**
     * Render configuration injected by the extension host, or null when
     * running as a standalone page.
     */
    function getInjectedConfig() {
        return (window.__flightMapConfig && typeof window.__flightMapConfig === 'object')
            ? window.__flightMapConfig
            : null;
    }

    return {
        isHosted: isHosted,
        post: post,
        on: on,
        getInjectedConfig: getInjectedConfig
    };
})();
