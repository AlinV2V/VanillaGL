export class GlueOverlay {
  private activeScreen: HTMLElement | null = null;
  private loadingEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(private readonly container: HTMLElement) {
    this.container.style.display = 'block';
  }

  showScreen(contentHtml: string): HTMLElement {
    this.clear();
    const screen = document.createElement('div');
    screen.className = 'glue-screen';
    screen.innerHTML = contentHtml;
    this.container.appendChild(screen);
    this.activeScreen = screen;
    return screen;
  }

  showLoading(message: string) {
    this.hideLoading();
    const loader = document.createElement('div');
    loader.className = 'glue-popup-overlay';
    loader.innerHTML = `
      <div class="glue-dialog glue-loading-dialog">
        <div class="glue-dialog-header">Connecting</div>
        <div class="glue-dialog-body">
          <p id="glue-loading-msg">${this.escape(message)}</p>
          <div class="glue-loading-bar">
            <div class="glue-loading-bar-fill"></div>
          </div>
        </div>
      </div>
    `;
    this.container.appendChild(loader);
    this.loadingEl = loader;
  }

  updateLoading(message: string) {
    const msgEl = document.getElementById('glue-loading-msg');
    if (msgEl) {
      msgEl.textContent = message;
    }
  }

  hideLoading() {
    if (this.loadingEl) {
      this.container.removeChild(this.loadingEl);
      this.loadingEl = null;
    }
  }

  showError(message: string, onOk?: () => void) {
    this.hideError();
    const err = document.createElement('div');
    err.className = 'glue-popup-overlay';
    err.innerHTML = `
      <div class="glue-dialog glue-error-dialog">
        <div class="glue-dialog-header">Error</div>
        <div class="glue-dialog-body">
          <p class="glue-error-text">${this.escape(message)}</p>
          <div class="glue-dialog-actions" style="margin-top: 15px; text-align: center;">
            <button id="glue-error-ok" class="glue-button">Okay</button>
          </div>
        </div>
      </div>
    `;
    this.container.appendChild(err);
    this.errorEl = err;

    const okBtn = err.querySelector('#glue-error-ok')!;
    okBtn.addEventListener('click', () => {
      this.hideError();
      if (onOk) onOk();
    });
  }

  hideError() {
    if (this.errorEl) {
      this.container.removeChild(this.errorEl);
      this.errorEl = null;
    }
  }

  clear() {
    this.hideLoading();
    this.hideError();
    this.container.innerHTML = '';
    this.activeScreen = null;
  }

  destroy() {
    this.clear();
    this.container.style.display = 'none';
  }

  private escape(value: string) {
    return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  }
}
