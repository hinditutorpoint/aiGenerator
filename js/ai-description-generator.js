/**
 * AI Description Generator – production-hardened frontend module
 * Requires : jQuery 3.x
 * Optional : DOMPurify (mandatory when rendering HTML responses)
 * Stylesheet: ../css/ai-description-generator.css (CSP-safe, no inline styles)
 *
 * IMPORTANT – This is a frontend helper only. The Laravel endpoint MUST enforce
 * authentication, authorization, validation, rate-limiting, and provider-side
 * limits. Never pass API keys or bearer tokens through `apiHeaders`; use
 * session-based auth (cookies) only.
 *
 * @version 4.1.0
 */
(function ($, window, document) {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* 0. Guards                                                          */
    /* ------------------------------------------------------------------ */
    if (!$ || typeof $.fn !== 'object') {
        throw new Error('AI Description Generator requires jQuery 3.x.');
    }

    /* ------------------------------------------------------------------ */
    /* 1. Secure random ID helper                                         */
    /* ------------------------------------------------------------------ */
    function secureId() {
        // Prefer crypto.randomUUID; fall back to crypto.getRandomValues.
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            var buf = new Uint8Array(16);
            window.crypto.getRandomValues(buf);
            return Array.from(buf, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        }
        // Last resort (non-crypto) – acceptable for DOM IDs only.
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /* ------------------------------------------------------------------ */
    /* 2. Sanitise server error messages                                   */
    /* ------------------------------------------------------------------ */
    var GENERIC_ERROR = 'Something went wrong. Please try again.';

    /**
     * Strip stack traces, SQL fragments, file paths, and overly long messages
     * from server responses before surfacing them in the UI.
     */
    function sanitiseErrorMessage(raw, fallback) {
        if (typeof raw !== 'string' || !raw.trim()) return fallback || GENERIC_ERROR;
        // Block common server-leak patterns.
        if (/stack\s*trace|SQLSTATE|at\s+\w+\.\w+\s*\(|\/[a-z]+\/[a-z]+\//i.test(raw)) {
            return fallback || GENERIC_ERROR;
        }
        // Truncate absurdly long messages.
        if (raw.length > 300) return raw.slice(0, 297) + '…';
        return raw;
    }

    /* ------------------------------------------------------------------ */
    /* 3. Blocked header names (never forward these client-side)           */
    /* ------------------------------------------------------------------ */
    var BLOCKED_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie)$/i;

    function safeHeaders(custom) {
        var out = {};
        if (custom && typeof custom === 'object') {
            Object.keys(custom).forEach(function (key) {
                if (!BLOCKED_HEADERS.test(key)) out[key] = custom[key];
            });
        }
        return out;
    }

    /* ------------------------------------------------------------------ */
    /* 4. Core module                                                      */
    /* ------------------------------------------------------------------ */
    var AIGenerator = {

        /* ---------- Configuration ------------------------------------ */
        config: {
            buttonClass:        'ai-generate-btn',
            buttonVoice:        'ai-voice-btn',
            wrapperClass:       'ai-textarea-wrapper',
            activeClass:        'ai-active',
            modalClass:         'ai-generator-modal',
            apiEndpoint:        '/api/ai/generate',
            apiMethod:          'POST',
            apiHeaders:         {},                   // session-based only – no API keys
            defaultMaxTokens:   200,
            defaultTemperature: 0.7,
            timeout:            60000,
            closeOnOutsideClick: false,
            maxPromptLength:    1000,
            minPromptLength:    10,
            maxTokens:          2000,
            minTokens:          50,
            cooldownMs:         2000,                 // anti-spam cooldown between requests
            i18n: {
                title:              'AI Content Generator',
                generate:           'Generate',
                generating:         'Generating…',
                insert:             'Insert',
                cancel:             'Cancel',
                promptLabel:        'Prompt',
                promptPlaceholder:  'Describe what you want to generate…',
                maxLengthLabel:     'Max Length',
                creativityLabel:    'Creativity',
                resultLabel:        'Generated Content',
                errorMessage:       GENERIC_ERROR,
                loadingText:        'Generating content…',
                back:               'Back to prompt',
                generateVoice:      'Speak to content'
            },
            prefill: { enabled: true, maxLength: 500, append: false }
        },

        /* ---------- Internal state ----------------------------------- */
        /** @type {Map<string, object>} */
        instances: new Map(),
        /** @type {SpeechRecognition|null} */
        recognition:        null,
        /** @type {string|null} target textarea ID while voice is active */
        voiceTargetId:      null,
        isListening:        false,
        /** @type {MutationObserver|null} */
        observer:           null,
        initialized:        false,
        /** @type {WeakMap<Element, AbortController>} */
        requestControllers: new WeakMap(),
        /** @type {number} timestamp of last successful request dispatch */
        _lastRequestTime:   0,

        /* ============================================================= */
        /* Lifecycle                                                      */
        /* ============================================================= */

        /**
         * Initialise or re-initialise the module.
         * Safe to call multiple times – previous handlers are unbound first.
         */
        init: function (options) {
            this.config = $.extend(true, {}, this.config, options || {});

            // Namespaced delegated handlers – idempotent.
            $(document).off('.aiGenerator');
            $(document).on('click.aiGenerator',   '.' + this.config.buttonClass, this._handleButtonClick.bind(this));
            $(document).on('click.aiGenerator',   '.' + this.config.buttonVoice, this._handleVoiceButtonClick.bind(this));

            this._scanTextareas();
            this._setupMutationObserver();
            this.initialized = true;
            return this;
        },

        /**
         * Tear down everything: handlers, observers, DOM additions.
         */
        destroy: function () {
            $(document).off('.aiGenerator');
            if (this.observer) { this.observer.disconnect(); this.observer = null; }
            if (this.recognition) {
                try { this.recognition.abort(); } catch (_) { /* noop */ }
                this.recognition = null;
            }
            this.isListening  = false;
            this.voiceTargetId = null;

            this.instances.forEach(function (inst) {
                inst.$textarea.removeData('ai-generator-attached');
                if (inst.$button)      inst.$button.remove();
                if (inst.$voiceButton) inst.$voiceButton.remove();
            });
            this.instances.clear();
            $('.' + this.config.modalClass).remove();
            this.initialized = false;
        },

        /**
         * Detach AI from a single textarea without affecting other instances.
         * @param {jQuery|string} target  jQuery object or selector for the textarea.
         */
        detach: function (target) {
            var $textarea = (typeof target === 'string') ? $(target) : $(target);
            if (!$textarea || !$textarea.length) return;

            var id = $textarea.attr('id');
            var inst = id ? this.instances.get(id) : null;

            // Remove associated modal
            if (id) {
                var modalId = 'ai-generator-modal-' + id;
                $('#' + CSS.escape(modalId)).remove();
            }

            // Remove buttons
            if (inst) {
                if (inst.$button)      inst.$button.remove();
                if (inst.$voiceButton) inst.$voiceButton.remove();
            } else {
                $textarea.parent().find('.' + this.config.buttonClass + ', .' + this.config.buttonVoice).remove();
            }

            // Unwrap if wrapped
            var $wrapper = $textarea.parent();
            if ($wrapper.hasClass(this.config.wrapperClass)) {
                $textarea.unwrap();
            }

            // Remove data-ai-generate attribute so mutation observer or subsequent scans don't immediately reattach
            $textarea.removeAttr('data-ai-generate');

            // Reset textarea state
            $textarea.css('padding-right', '');
            $textarea.removeData('ai-generator-attached');
            $textarea.data('ai-generator-attached', false);

            // Remove from tracking
            if (id) {
                this.instances.delete(id);
            }
        },

        /* ============================================================= */
        /* Textarea scanning / attachment                                 */
        /* ============================================================= */

        _scanTextareas: function () {
            var self = this;
            $('textarea[data-ai-generate]').each(function () {
                self._attachAIButton($(this));
            });
        },

        _ensureTextareaId: function ($textarea) {
            var id = $textarea.attr('id');
            if (!id) {
                id = 'ai-textarea-' + secureId();
                $textarea.attr('id', id);
            }
            return id;
        },

        _attachAIButton: function ($textarea, instanceOptions) {
            if (!$textarea || !$textarea.length || $textarea.data('ai-generator-attached')) return;

            var id = this._ensureTextareaId($textarea);

            if (!$textarea.parent().hasClass(this.config.wrapperClass)) {
                $textarea.wrap('<div class="' + this.config.wrapperClass + '"></div>');
            }

            var $wrapper   = $textarea.parent();
            var hasVoice   = $textarea.attr('data-ai-voice') === 'true';
            var rightSlot  = 6;
            var buttonWidth = 28; // width of icon button
            var buttonGap   = 2;  // compact gap between buttons
            var stepOffset  = buttonWidth + buttonGap;
            var $voiceBtn  = null;

            // Voice button (rightmost)
            if (hasVoice) {
                this._initSpeechRecognition();
                $voiceBtn = $('<button>', {
                    type:             'button',
                    'class':          this.config.buttonVoice + ' ai-icon-btn',
                    title:            this.config.i18n.generateVoice,
                    'aria-label':     this.config.i18n.generateVoice,
                    'aria-pressed':   'false',
                    'data-target-id': id
                }).html(this._microphoneIcon()).css('right', rightSlot + 'px');
                $wrapper.append($voiceBtn);
                rightSlot += stepOffset;
            }

            // Generate button
            var $button = $('<button>', {
                type:             'button',
                'class':          this.config.buttonClass + ' ai-icon-btn',
                title:            this.config.i18n.generate,
                'aria-label':     this.config.i18n.generate,
                'data-target-id': id
            }).html(this._generateIcon()).css('right', rightSlot + 'px');
            $wrapper.append($button);

            // Reserve padding so text doesn't sit under buttons.
            var currentPadding = parseInt($textarea.css('padding-right'), 10) || 0;
            var totalButtonArea = rightSlot + buttonWidth + 4;
            $textarea.css('padding-right', Math.max(currentPadding, totalButtonArea) + 'px');
            $textarea.data('ai-generator-attached', true);

            this.instances.set(id, {
                $textarea:       $textarea,
                $button:         $button,
                $voiceButton:    $voiceBtn,
                instanceOptions: instanceOptions || null,
                context:         this._detectContext($textarea)
            });
        },

        /* ============================================================= */
        /* SVG icons                                                      */
        /* ============================================================= */

        _generateIcon: function () {
            return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 128 128" fill="none" aria-hidden="true">' +
                '<rect x="14" y="32" width="88" height="68" rx="16" fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="round"/>' +
                '<path d="M38 58h40" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>' +
                '<path d="M38 76h28" stroke="currentColor" stroke-width="8" stroke-linecap="round"/>' +
                '<path d="M100 16l5 14 14 5-14 5-5 14-5-14-14-5 14-5z" fill="currentColor"/>' +
                '</svg>';
        },

        _microphoneIcon: function () {
            return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
                '<path d="M8 0a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V3a3 3 0 0 0-3-3zM3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z"/></svg>';
        },

        /* ============================================================= */
        /* Context detection                                              */
        /* ============================================================= */

        _detectContext: function ($textarea) {
            var $parent = $textarea.closest('.modal, [role="dialog"]');
            return { isModal: $parent.length > 0, $parentModal: $parent };
        },

        /* ============================================================= */
        /* Speech Recognition (scoped per textarea)                       */
        /* ============================================================= */

        _initSpeechRecognition: function () {
            var SpeechAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
            if (!SpeechAPI || this.recognition) return;

            var self = this;
            this.recognition = new SpeechAPI();
            this.recognition.continuous      = false;
            this.recognition.interimResults  = false;
            this.recognition.lang            = 'en-US';

            this.recognition.onresult = function (event) {
                var transcript = event.results[0][0].transcript;
                // Write into the prompt input that belongs to the tracked target textarea.
                if (self.voiceTargetId) {
                    var $modal = self._findModalForTextarea(self.voiceTargetId);
                    if ($modal && $modal.length) {
                        var $input = $modal.find('.ai-prompt-input');
                        $input.val(($input.val() + ' ' + transcript).trim());
                    }
                }
            };

            this.recognition.onerror = function (event) {
                console.error('Speech recognition error:', event.error);
                self.isListening   = false;
                self.voiceTargetId = null;
                self._updateVoiceButtonStates();
            };

            this.recognition.onend = function () {
                self.isListening   = false;
                self.voiceTargetId = null;
                self._updateVoiceButtonStates();
            };
        },

        _findModalForTextarea: function (textareaId) {
            var modalId = 'ai-generator-modal-' + textareaId;
            return $('#' + CSS.escape(modalId));
        },

        _updateVoiceButtonStates: function () {
            var self = this;
            $('.' + this.config.buttonVoice).each(function () {
                var $btn      = $(this);
                var isTarget  = self.isListening && $btn.attr('data-target-id') === self.voiceTargetId;
                $btn.attr('aria-pressed', isTarget ? 'true' : 'false');
                $btn.toggleClass('ai-voice-active', isTarget);
            });
        },

        /* ============================================================= */
        /* Button click handlers                                          */
        /* ============================================================= */

        _handleButtonClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            var id       = $(event.currentTarget).attr('data-target-id');
            var instance = this.instances.get(id);
            if (instance) this._showModal(instance);
        },

        _handleVoiceButtonClick: function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (!this.recognition) {
                window.alert('Speech recognition is not supported in this browser.');
                return;
            }
            var targetId = $(event.currentTarget).attr('data-target-id');
            try {
                if (this.isListening) {
                    this.recognition.stop();
                    this.isListening   = false;
                    this.voiceTargetId = null;
                } else {
                    this.voiceTargetId = targetId;
                    this.recognition.start();
                    this.isListening = true;
                }
                this._updateVoiceButtonStates();
            } catch (error) {
                console.error('Speech recognition error:', error);
                this.isListening   = false;
                this.voiceTargetId = null;
                this._updateVoiceButtonStates();
            }
        },

        /* ============================================================= */
        /* Modal lifecycle                                                */
        /* ============================================================= */

        _showModal: function (instance) {
            var $textarea = instance.$textarea;
            var id        = 'ai-generator-modal-' + this._ensureTextareaId($textarea);
            var selection = this._getTextSelection($textarea[0]);
            var $modal    = $('#' + CSS.escape(id));

            if (!$modal.length) {
                $modal = this._createModal(id, instance.instanceOptions);
                $('body').append($modal);
                this._setupModalEvents($modal);
            }

            // Re-parent into a dialog ancestor if the textarea lives inside one.
            var ctx = instance.context;
            (ctx.isModal && ctx.$parentModal.length ? ctx.$parentModal : $('body')).append($modal);

            $modal.data('target',    $textarea);
            $modal.data('selection', selection);

            // Reset state.
            $modal.find('.ai-max-length').val($textarea.attr('maxlength') || this.config.defaultMaxTokens);
            $modal.find('.ai-creativity').val(String(this.config.defaultTemperature));
            $modal.find('.ai-response-error').hide().text('');
            $modal.find('.ai-result-section, .ai-loading-indicator').hide();
            $modal.find('.ai-prompt-group, .ai-options-grid, .ai-modal-footer').show();

            // Enable generate button (may have been disabled by cooldown).
            $modal.find('.ai-generate-btn, .ai-regenerate-btn').prop('disabled', false);

            this._prefillPrompt($textarea, $modal, selection);

            $modal.addClass(this.config.activeClass);
            $modal[0].inert = false;
            $modal.removeAttr('aria-hidden');
            if (this.config.closeOnOutsideClick) $modal.addClass('ai-overlay-clickable');

            // Focus the prompt – deferred so the DOM settles.
            var $prompt = $modal.find('.ai-prompt-input');
            window.requestAnimationFrame(function () { $prompt.trigger('focus'); });
        },

        _getTextSelection: function (element) {
            var start = element.selectionStart || 0;
            var end   = element.selectionEnd   || 0;
            return { start: start, end: end, text: element.value.substring(start, end) };
        },

        _prefillPrompt: function ($textarea, $modal, selection) {
            if (!this.config.prefill.enabled) return;
            var value = (selection.start !== selection.end && selection.text.trim())
                ? selection.text
                : $textarea.val();
            value = this._toPlainText(value).slice(0, this.config.prefill.maxLength);
            if (value) {
                var $input = $modal.find('.ai-prompt-input');
                $input.val(this.config.prefill.append ? ($input.val() + ' ' + value).trim() : value);
            }
        },

        /**
         * Convert arbitrary string to safe plain text (strip HTML entities,
         * collapse whitespace). Uses textContent, never innerHTML.
         */
        _toPlainText: function (value) {
            if (value == null) return '';
            var str = String(value);
            // Create a detached text node – no HTML parsing side-effects.
            var div = document.createElement('div');
            div.textContent = str;
            return div.textContent
                .replace(/[\r\n]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        },

        /* ============================================================= */
        /* Modal DOM construction                                         */
        /* ============================================================= */

        _createModal: function (id, instanceOptions) {
            var cfg = $.extend(true, {}, this.config, instanceOptions || {});
            var t = cfg.i18n;

            var $modal   = $('<div>', { id: id, 'class': this.config.modalClass, 'aria-hidden': 'true', tabindex: '-1' });
            $modal[0].inert = true;
            var $content = $('<div>', { 'class': 'ai-modal-content', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.title });

            $content.append(
                // Header
                $('<div>', { 'class': 'ai-modal-header' }).append(
                    $('<h3>').text(t.title),
                    $('<button>', { type: 'button', 'class': 'ai-modal-close', 'aria-label': 'Close' }).text('×')
                ),

                // Body
                $('<div>', { 'class': 'ai-modal-body' }).append(
                    // Prompt
                    $('<div>', { 'class': 'ai-form-group ai-prompt-group' }).append(
                        $('<label>').text(t.promptLabel),
                        $('<textarea>', {
                            'class':     'ai-prompt-input',
                            placeholder: t.promptPlaceholder,
                            rows:        3,
                            maxlength:   this.config.maxPromptLength
                        })
                    ),
                    // Options
                    $('<div>', { 'class': 'ai-options-grid' }).append(
                        $('<div>', { 'class': 'ai-form-group' }).append(
                            $('<label>').text(t.maxLengthLabel),
                            $('<input>', {
                                type:    'number',
                                'class': 'ai-form-control ai-max-length',
                                min:     this.config.minTokens,
                                max:     this.config.maxTokens,
                                value:   this.config.defaultMaxTokens,
                                step:    1
                            })
                        ),
                        $('<div>', { 'class': 'ai-form-group' }).append(
                            $('<label>').text(t.creativityLabel),
                            $('<select>', { 'class': 'ai-form-control ai-creativity' }).append(
                                $('<option>', { value: '0.3' }).text('Low'),
                                $('<option>', { value: '0.7', selected: true }).text('Medium'),
                                $('<option>', { value: '1.0' }).text('High')
                            )
                        )
                    ),
                    // Error
                    $('<div>', { 'class': 'ai-response-error', role: 'alert', 'aria-live': 'assertive' }).hide(),
                    // Result
                    $('<div>', { 'class': 'ai-result-section' }).hide().append(
                        $('<div>', { 'class': 'ai-form-group' }).append(
                            $('<label>').text(t.resultLabel),
                            $('<div>', { 'class': 'ai-result-content' }),
                            $('<div>', { 'class': 'ai-actions' }).append(
                                $('<button>', { type: 'button', 'class': 'ai-back-btn btn-secondary' }).text(t.back),
                                $('<button>', { type: 'button', 'class': 'ai-insert-btn btn-primary' }).text(t.insert),
                                $('<button>', { type: 'button', 'class': 'ai-regenerate-btn btn-primary' }).text(t.generate)
                            )
                        )
                    ),
                    // Loading
                    $('<div>', { 'class': 'ai-loading-indicator' }).hide().append(
                        $('<div>', { 'class': 'ai-spinner' }),
                        $('<p>').text(t.loadingText)
                    )
                ),

                // Footer
                $('<div>', { 'class': 'ai-modal-footer' }).append(
                    $('<button>', { type: 'button', 'class': 'ai-generate-btn btn-primary' }).text(t.generate),
                    $('<button>', { type: 'button', 'class': 'ai-cancel-btn btn-secondary' }).text(t.cancel)
                )
            );

            $modal.append($('<div>', { 'class': 'ai-modal-overlay' }), $content);
            return $modal;
        },

        /* ============================================================= */
        /* Modal event wiring                                             */
        /* ============================================================= */

        _setupModalEvents: function ($modal) {
            var self = this;

            $modal.on('click.aiGenerator', '.ai-modal-close, .ai-cancel-btn', function () {
                self._closeModal($modal);
            });

            $modal.on('click.aiGenerator', '.ai-generate-btn, .ai-regenerate-btn', function () {
                self._generateContent($modal);
            });

            $modal.on('click.aiGenerator', '.ai-back-btn', function () {
                $modal.find('.ai-prompt-group, .ai-options-grid, .ai-modal-footer').show();
                $modal.find('.ai-result-section').hide();
            });

            $modal.on('click.aiGenerator', '.ai-insert-btn', function () {
                self._insertResult($modal);
            });

            // Keyboard: Escape closes.
            $modal.on('keydown.aiGenerator', function (event) {
                if (event.key === 'Escape') self._closeModal($modal);
            });

            // Click-outside (overlay).
            $modal.on('click.aiGenerator', '.ai-modal-overlay', function (event) {
                if (self.config.closeOnOutsideClick && event.target === event.currentTarget) {
                    self._closeModal($modal);
                }
            });
        },

        _closeModal: function ($modal) {
            // Abort any in-flight request tied to this modal.
            var controller = this.requestControllers.get($modal[0]);
            if (controller) { controller.abort(); }

            // Move focus out before hiding so assistive tech isn't disrupted.
            var active = document.activeElement;
            if (active && $modal[0].contains(active)) {
                active.blur();
            }

            $modal.removeClass(this.config.activeClass);
            $modal[0].inert = true;
            $modal.attr('aria-hidden', 'true');
        },

        _insertResult: function ($modal) {
            var $textarea = $modal.data('target');
            if (!$textarea || !$textarea.length) return;
            var text = $modal.data('generatedText') || '';
            $textarea.val(text);
            // Trigger standard events so frameworks/validators pick up the change.
            $textarea.trigger('input').trigger('change');
            $textarea.trigger('aiContentInserted', [text]);
            this._closeModal($modal);
        },

        /* ============================================================= */
        /* Content generation (API call)                                  */
        /* ============================================================= */

        _generateContent: function ($modal) {
            var self = this;

            // --- Anti-spam cooldown ----------------------------------
            var now = Date.now();
            if (now - this._lastRequestTime < this.config.cooldownMs) {
                this._showError($modal, 'Please wait a moment before generating again.');
                return;
            }

            var $textarea      = $modal.data('target');
            var prompt         = String($modal.find('.ai-prompt-input').val() || '').trim();
            var maxLength      = Math.round(Number($modal.find('.ai-max-length').val()));
            var temperature    = Number($modal.find('.ai-creativity').val());
            var responseFormat = ($textarea && $textarea.attr('data-ai-response') === 'html') ? 'html' : 'text';

            // --- Validation ------------------------------------------
            if (prompt.length < this.config.minPromptLength || prompt.length > this.config.maxPromptLength) {
                this._showError($modal, 'Prompt must be between ' + this.config.minPromptLength + ' and ' + this.config.maxPromptLength + ' characters.');
                return;
            }
            if (!Number.isInteger(maxLength) || maxLength < this.config.minTokens || maxLength > this.config.maxTokens) {
                this._showError($modal, 'Maximum length must be between ' + this.config.minTokens + ' and ' + this.config.maxTokens + '.');
                return;
            }
            // Temperature must match one of the offered select values.
            var validTemps = [0.3, 0.7, 1.0];
            if (!Number.isFinite(temperature) || validTemps.indexOf(temperature) === -1) {
                this._showError($modal, 'Creativity value is invalid.');
                return;
            }

            // --- Abort previous in-flight request --------------------
            var previous = this.requestControllers.get($modal[0]);
            if (previous) previous.abort();
            var controller = new AbortController();
            this.requestControllers.set($modal[0], controller);

            // --- UI: show loading ------------------------------------
            $modal.find('.ai-response-error').hide();
            $modal.find('.ai-prompt-group, .ai-options-grid, .ai-modal-footer, .ai-result-section').hide();
            $modal.find('.ai-loading-indicator').show();
            $modal.find('.ai-generate-btn, .ai-regenerate-btn').prop('disabled', true);

            this._lastRequestTime = now;

            this._callApi({ prompt: prompt, maxLength: maxLength, responseFormat: responseFormat, temperature: temperature }, controller.signal)
                .then(function (result) {
                    var content = self._extractContent(result);
                    if (typeof content !== 'string') {
                        throw new Error('The API returned an invalid response format.');
                    }

                    $modal.data('generatedText', content);
                    var $resultDiv = $modal.find('.ai-result-content').empty();

                    if (responseFormat === 'html') {
                        if (!window.DOMPurify || typeof window.DOMPurify.sanitize !== 'function') {
                            throw new Error('HTML output requires DOMPurify. Load DOMPurify before enabling HTML responses.');
                        }
                        $resultDiv.html(window.DOMPurify.sanitize(content, {
                            ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
                            ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'],
                            ALLOW_DATA_ATTR: false,
                            ADD_ATTR: ['target'],
                            FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button'],
                            FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover']
                        }));
                        // Force all links to open in a new tab safely.
                        $resultDiv.find('a').attr({ target: '_blank', rel: 'noopener noreferrer' });
                    } else {
                        $resultDiv.text(content);
                    }

                    $modal.find('.ai-loading-indicator').hide();
                    $modal.find('.ai-result-section').show();
                    $modal.find('.ai-regenerate-btn').prop('disabled', false);
                    if ($textarea) $textarea.trigger('aiContentGenerated', [content]);
                })
                .catch(function (error) {
                    if (error && error.name === 'AbortError') return;
                    self._showError($modal, sanitiseErrorMessage(error && error.message, self.config.i18n.errorMessage));
                    $modal.find('.ai-prompt-group, .ai-options-grid, .ai-modal-footer').show();
                    $modal.find('.ai-loading-indicator, .ai-result-section').hide();
                    $modal.find('.ai-generate-btn, .ai-regenerate-btn').prop('disabled', false);
                })
                .finally(function () {
                    if (self.requestControllers.get($modal[0]) === controller) {
                        self.requestControllers.delete($modal[0]);
                    }
                });
        },

        /* ============================================================= */
        /* API call with timeout, CSRF, and header sanitisation           */
        /* ============================================================= */

        _callApi: function (payload, signal) {
            var self = this;

            var headers = $.extend(
                {},
                safeHeaders(this.config.apiHeaders),   // strip forbidden headers
                {
                    'Content-Type':    'application/json',
                    'Accept':          'application/json',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            );

            // CSRF token (Laravel convention).
            var csrf = $('meta[name="csrf-token"]').attr('content');
            if (csrf && !headers['X-CSRF-TOKEN']) {
                headers['X-CSRF-TOKEN'] = csrf;
            }

            // Composite abort: user-cancel OR timeout.
            var timeoutController = new AbortController();
            var timeoutId = window.setTimeout(function () { timeoutController.abort(); }, self.config.timeout);
            var onUserAbort = function () { timeoutController.abort(); };
            signal.addEventListener('abort', onUserAbort, { once: true });

            return fetch(this.config.apiEndpoint, {
                method:      this.config.apiMethod || 'POST',
                credentials: 'same-origin',
                headers:     headers,
                body:        JSON.stringify(payload),
                signal:      timeoutController.signal
            })
            .then(function (response) {
                // Validate Content-Type is JSON before parsing.
                var ct = response.headers.get('Content-Type') || '';
                if (ct.indexOf('application/json') === -1) {
                    throw new Error('The server returned an unexpected response format.');
                }
                return response.json().then(function (data) {
                    if (!response.ok) {
                        var message = '';
                        if (data && data.message) {
                            message = data.message;
                        } else if (data && data.errors) {
                            try { message = Object.values(data.errors).flat().join(' '); } catch (_) { /* noop */ }
                        }
                        message = message || ('Request failed (' + response.status + ').');
                        throw new Error(sanitiseErrorMessage(message, GENERIC_ERROR));
                    }
                    return data;
                });
            })
            .catch(function (error) {
                if (error && error.name === 'AbortError' && !signal.aborted) {
                    throw new Error('The request timed out. Please try again.');
                }
                throw error;
            })
            .finally(function () {
                window.clearTimeout(timeoutId);
                signal.removeEventListener('abort', onUserAbort);
            });
        },

        /* ============================================================= */
        /* Response extraction                                            */
        /* ============================================================= */

        _extractContent: function (response) {
            if (typeof response === 'string') return response;
            if (!response || typeof response !== 'object') return null;
            // Adjust this list to match the JSON contract of your Laravel API.
            var candidates = [
                response.content,
                response.text,
                response.output,
                response.result,
                response.data && response.data.content
            ];
            for (var i = 0; i < candidates.length; i++) {
                if (typeof candidates[i] === 'string') return candidates[i];
            }
            return null;
        },

        /* ============================================================= */
        /* Error display                                                  */
        /* ============================================================= */

        _showError: function ($modal, message) {
            $modal.find('.ai-response-error')
                .text(sanitiseErrorMessage(message, this.config.i18n.errorMessage))
                .show();
        },

        /* ============================================================= */
        /* MutationObserver (dynamic textarea detection)                   */
        /* ============================================================= */

        _setupMutationObserver: function () {
            if (this.observer) this.observer.disconnect();
            if (!document.body || !window.MutationObserver) return;

            var self = this;
            this.observer = new MutationObserver(function (records) {
                for (var r = 0; r < records.length; r++) {
                    var nodes = records[r].addedNodes;
                    for (var n = 0; n < nodes.length; n++) {
                        var node = nodes[n];
                        if (node.nodeType !== 1) continue;
                        var $node = $(node);
                        if ($node.is('textarea[data-ai-generate]')) self._attachAIButton($node);
                        $node.find('textarea[data-ai-generate]').each(function () { self._attachAIButton($(this)); });
                    }
                }
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
        }
    };

    /* ================================================================= */
    /* jQuery plugin                                                      */
    /* ================================================================= */
    $.fn.aiDescriptionGenerator = function (options) {
        if (options === 'destroy' || options === 'detach') {
            return this.each(function () {
                AIGenerator.detach($(this));
            });
        }
        return this.each(function () {
            var $textarea = $(this);
            $textarea.attr('data-ai-generate', 'true');
            AIGenerator._attachAIButton($textarea, options);
        });
    };

    /* ================================================================= */
    /* Auto-init on DOM ready                                             */
    /* ================================================================= */
    $(function () {
        AIGenerator.init();
    });

    /* ================================================================= */
    /* Expose as a frozen, non-writable global                            */
    /* ================================================================= */
    try {
        Object.defineProperty(window, 'AIGenerator', {
            value:        AIGenerator,
            writable:     false,
            enumerable:   true,
            configurable: false
        });
    } catch (_) {
        // Fallback for environments where defineProperty on window fails.
        window.AIGenerator = AIGenerator;
    }

})(window.jQuery, window, document);
