// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// This file defines the 'show-authorized-user' command for the clasp CLI.
import { Command } from 'commander';
import { getUserInfo } from '../auth/auth.js';
import { getOAuthClientType } from '../auth/oauth_client.js';
import { intl } from '../intl.js';
export const command = new Command('show-authorized-user')
    .description('Show information about the current authorizations state.')
    .action(async function () {
    var _a, _b;
    const options = this.optsWithGlobals();
    const auth = options.authInfo;
    let user = undefined;
    if (auth.credentials) {
        user = await getUserInfo(auth.credentials);
    }
    const clientId = (_a = auth.credentials) === null || _a === void 0 ? void 0 : _a._clientId;
    const clientType = getOAuthClientType(clientId);
    if (options.json) {
        const output = {
            loggedIn: auth.credentials ? true : false,
            email: (_b = user === null || user === void 0 ? void 0 : user.email) !== null && _b !== void 0 ? _b : undefined,
            clientId: clientId !== null && clientId !== void 0 ? clientId : undefined,
            clientType: clientType !== null && clientType !== void 0 ? clientType : undefined,
        };
        console.log(JSON.stringify(output, null, 2));
        return;
    }
    if (!auth.credentials) {
        const msg = intl.formatMessage({ id: "ZqMsgV", defaultMessage: [{ type: 0, value: "Not logged in." }] });
        console.log(msg);
        return;
    }
    const msg = intl.formatMessage({ id: "sZ9k34", defaultMessage: [{ type: 5, value: "email", options: { undefined: { value: [{ type: 0, value: "You are logged in as an unknown user." }] }, other: { value: [{ type: 0, value: "You are logged in as " }, { type: 1, value: "email" }, { type: 0, value: "." }] } } }] }, {
        email: user === null || user === void 0 ? void 0 : user.email,
    });
    console.log(msg);
    const clientMsg = intl.formatMessage({ id: "poUW0z", defaultMessage: [{ type: 0, value: "OAuth client ID: " }, { type: 1, value: "clientId" }, { type: 0, value: " (" }, { type: 1, value: "clientType" }, { type: 0, value: ")." }] }, {
        clientId: clientId !== null && clientId !== void 0 ? clientId : 'unknown',
        clientType: clientType !== null && clientType !== void 0 ? clientType : 'unknown',
    });
    console.log(clientMsg);
});
