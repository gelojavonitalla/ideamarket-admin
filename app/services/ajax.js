import get from 'ember-metal/get';
import computed from 'ember-computed';
import injectService from 'ember-service/inject';
import {isEmberArray} from 'ember-array/utils';
import {isNone} from 'ember-utils';
import AjaxService from 'ember-ajax/services/ajax';
import {AjaxError, isAjaxError} from 'ember-ajax/errors';
import config from 'ideamarket-admin/config/environment';

const JSONContentType = 'application/json';

function isJSONContentType(header) {
    if (!header || isNone(header)) {
        return false;
    }
    return header.indexOf(JSONContentType) === 0;
}

/* Version mismatch error */

export function VersionMismatchError(errors) {
    AjaxError.call(this, errors, 'API server is running a newer version of Ghost, please upgrade.');
}

VersionMismatchError.prototype = Object.create(AjaxError.prototype);

export function isVersionMismatchError(errorOrStatus, payload) {
    if (isAjaxError(errorOrStatus)) {
        return errorOrStatus instanceof VersionMismatchError;
    } else {
        return get(payload || {}, 'errors.firstObject.errorType') === 'VersionMismatchError';
    }
}

/* Request entity too large error */

export function ServerUnreachableError(errors) {
    AjaxError.call(this, errors, 'Server was unreachable');
}

ServerUnreachableError.prototype = Object.create(AjaxError.prototype);

export function isServerUnreachableError(error) {
    if (isAjaxError(error)) {
        return error instanceof ServerUnreachableError;
    } else {
        return error === 0 || error === '0';
    }
}

export function RequestEntityTooLargeError(errors) {
    AjaxError.call(this, errors, 'Request is larger than the maximum file size the server allows');
}

RequestEntityTooLargeError.prototype = Object.create(AjaxError.prototype);

export function isRequestEntityTooLargeError(errorOrStatus) {
    if (isAjaxError(errorOrStatus)) {
        return errorOrStatus instanceof RequestEntityTooLargeError;
    } else {
        return errorOrStatus === 413;
    }
}

/* Unsupported media type error */

export function UnsupportedMediaTypeError(errors) {
    AjaxError.call(this, errors, 'Request contains an unknown or unsupported file type.');
}

UnsupportedMediaTypeError.prototype = Object.create(AjaxError.prototype);

export function isUnsupportedMediaTypeError(errorOrStatus) {
    if (isAjaxError(errorOrStatus)) {
        return errorOrStatus instanceof UnsupportedMediaTypeError;
    } else {
        return errorOrStatus === 415;
    }
}

/* Maintenance error */

export function MaintenanceError(errors) {
    AjaxError.call(this, errors, 'Ghost is currently undergoing maintenance, please wait a moment then retry.');
}

MaintenanceError.prototype = Object.create(AjaxError.prototype);

export function isMaintenanceError(errorOrStatus) {
    if (isAjaxError(errorOrStatus)) {
        return errorOrStatus instanceof MaintenanceError;
    } else {
        return errorOrStatus === 503;
    }
}

/* Theme validation error */

export function ThemeValidationError(errors) {
    AjaxError.call(this, errors, 'Theme is not compatible or contains errors.');
}

ThemeValidationError.prototype = Object.create(AjaxError.prototype);

export function isThemeValidationError(errorOrStatus, payload) {
    if (isAjaxError(errorOrStatus)) {
        return errorOrStatus instanceof ThemeValidationError;
    } else {
        return get(payload || {}, 'errors.firstObject.errorType') === 'ThemeValidationError';
    }
}

/* end: custom error types */

let ajaxService = AjaxService.extend({
    session: injectService(),

    headers: computed('session.isAuthenticated', function () {
        let session = this.get('session');
        let headers = {};

        headers['X-Ghost-Version'] = config.APP.version;

        if (session.get('isAuthenticated')) {
            session.authorize('authorizer:oauth2', (headerName, headerValue) => {
                headers[headerName] = headerValue;
            });
        }

        return headers;
    }).volatile(),

    // ember-ajax recognises `application/vnd.api+json` as a JSON-API request
    // and formats appropriately, we want to handle `application/json` the same
    _makeRequest(hash) {
        let isAuthenticated = this.get('session.isAuthenticated');
        let isGhostRequest = hash.url.indexOf('/ghost/api/') !== -1;
        let isTokenRequest = isGhostRequest && hash.url.match(/authentication\/(?:token|ghost)/);
        let tokenExpiry = this.get('session.authenticated.expires_at');
        let isTokenExpired = tokenExpiry < (new Date()).getTime();

        if (isJSONContentType(hash.contentType) && hash.type !== 'GET') {
            if (typeof hash.data === 'object') {
                hash.data = JSON.stringify(hash.data);
            }
        }

        // we can get into a situation where the app is left open without a
        // network connection and the token subsequently expires, this will
        // result in the next network request returning a 401 and killing the
        // session. This is an attempt to detect that and restore the session
        // using the stored refresh token before continuing with the request
        //
        // TODO:
        // - this might be quite blunt, if we have a lot of requests at once
        //   we probably want to queue the requests until the restore completes
        // BUG:
        // - the original caller gets a rejected promise with `undefined` instead
        //   of the AjaxError object when session restore fails. This isn't a
        //   huge deal because the session will be invalidated and app reloaded
        //   but it would be nice to be consistent
        if (isAuthenticated && isGhostRequest && !isTokenRequest && isTokenExpired) {
            return this.get('session').restore().then(() => {
                return this._makeRequest(hash);
            });
        }

        return this._super(...arguments);
    },

    handleResponse(status, headers, payload) {
        if (this.isVersionMismatchError(status, headers, payload)) {
            return new VersionMismatchError(payload.errors);
        } else if (this.isServerUnreachableError(status, headers, payload)) {
            return new ServerUnreachableError(payload.errors);
        } else if (this.isRequestEntityTooLargeError(status, headers, payload)) {
            return new RequestEntityTooLargeError(payload.errors);
        } else if (this.isUnsupportedMediaTypeError(status, headers, payload)) {
            return new UnsupportedMediaTypeError(payload.errors);
        } else if (this.isMaintenanceError(status, headers, payload)) {
            return new MaintenanceError(payload.errors);
        } else if (this.isThemeValidationError(status, headers, payload)) {
            return new ThemeValidationError(payload.errors);
        }

        // TODO: we may want to check that we are hitting our own API before
        // logging the user out due to a 401 response
        if (this.isUnauthorizedError(status, headers, payload) && this.get('session.isAuthenticated')) {
            this.get('session').invalidate();
        }

        return this._super(...arguments);
    },

    normalizeErrorResponse(status, headers, payload) {
        if (payload && typeof payload === 'object') {
            let errors = payload.error || payload.errors || payload.message || undefined;

            if (errors) {
                if (!isEmberArray(errors)) {
                    errors = [errors];
                }

                payload.errors = errors.map(function(error) {
                    if (typeof error === 'string') {
                        return {message: error};
                    } else {
                        return error;
                    }
                });
            }
        }

        return this._super(status, headers, payload);
    },

    isVersionMismatchError(status, headers, payload) {
        return isVersionMismatchError(status, payload);
    },

    isServerUnreachableError(status/*, headers, payload */) {
        return isServerUnreachableError(status);
    },

    isRequestEntityTooLargeError(status/*, headers, payload */) {
        return isRequestEntityTooLargeError(status);
    },

    isUnsupportedMediaTypeError(status/*, headers, payload */) {
        return isUnsupportedMediaTypeError(status);
    },

    isMaintenanceError(status, headers, payload) {
        return isMaintenanceError(status, payload);
    },

    isThemeValidationError(status, headers, payload) {
        return isThemeValidationError(status, payload);
    }
});

// we need to reopen so that internal methods use the correct contentType
ajaxService.reopen({
    contentType: 'application/json; charset=UTF-8'
});

export default ajaxService;
