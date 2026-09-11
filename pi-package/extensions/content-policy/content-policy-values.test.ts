import * as assert from "node:assert/strict";

const { buildPolicy, scanArguments } = await import("./index.ts");

const policy = buildPolicy({});

function verdict(content: string): string | undefined {
	return scanArguments({ path: "src/oauth.ts", content }, policy.rules)?.rule.id;
}

// Ordinary source code names credentials without containing one.
const passes: string[] = [
	"struct TokenResponse { access_token: String, expires_in: u64, id_token: Option<String>, refresh_token: Option<String> }",
	"refresh_token: refreshToken",
	"access_token: response.access_token",
	"api_key: process.env.API_KEY",
	"client_secret = settings.clientSecret",
	'"access_token": "<your-token>"',
	"access_token=${ACCESS_TOKEN}",
	"access_token: '<your-token>'",
	"client_secret: {{ secrets.CLIENT_SECRET }}",
	"api_key: https://vault.internal/v2/keys/app",
	"api_key: config/tokens/v2.json",
	"password = input()",
	"password: string;",
	"password=${DB_PASSWORD}",
	'password = os.environ["PW"]',
	"password = form.password",
	"$password = $dbPassword2;",
	"password = hashlib.sha256(raw).hexdigest()",
	'password = "changeme"',
	"interface Session { accessToken: string; refreshToken?: string; expiresAt: number }",
	"req.headers.authorization = `Bearer ${token}`",
	"const oauth = new OAuthClient({ clientId, clientSecret: env.CLIENT_SECRET, redirectUri });",
	// Stand-in words count only as whole segments of the value.
	'api_key = "your_api_key_here"',
	"api_key: key_test_4eC39HqLyjWDarjtT1zd",
	// Reading an env var is code, not a .env file.
	'config.env.get("x")',
];
for (const sample of passes) {
	assert.equal(verdict(sample), undefined, `passes through: ${sample}`);
}

// Real-looking values still block, quoted or bare, under either rule.
const blocks: Array<[string, string]> = [
	["access_token=ya29.a0AfH6SMBx7Qk3n9vLw2Pq8rT5uY1zA4bC6dE8fG0h", "secret-label-value"],
	['api_key: "AIzaSyD9x8w7v6u5t4s3r2q1p0o9n8m7l6k5j4i3"', "secret-label-value"],
	["client_secret = 'Q~8fj3Ls9dK2mN4pR7tV1wX5yZ0aB3cD6eF9'", "secret-label-value"],
	['refresh_token: "1//0gXyZ-abcDEFghiJKLmnoPQRstuVWXyz"', "secret-label-value"],
	["refresh_token=1//0gXyZ-abcDEFghiJKLmnoPQRstuVWXyz", "secret-label-value"],
	['auth_token: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"', "secret-label-value"],
	['const accessToken = "ya29.a0AfH6SMBx7Qk3n9vLw2Pq8rT5uY1zA4bC6dE8fG0h";', "secret-label-value"],
	['password="hunter2!"', "password-assignment"],
	["PASSWORD=Sup3rS3cret2026", "password-assignment"],
	["password: 'hunter2!'", "password-assignment"],
	// A stand-in word buried inside a credential does not excuse it.
	['client_secret = "supersecret123"', "secret-label-value"],
	['api_key = "insertKey9f8a7b6c5d4e"', "secret-label-value"],
	// Struct fields around a leaked value do not shield it.
	['struct Cfg { access_token: String }\nlet cfg = Cfg { access_token: "ya29.a0AfH6SMBx7Qk3n9vLw2Pq8rT5uY1zA4bC6dE8fG0h".into() };', "secret-label-value"],
];
for (const [sample, ruleId] of blocks) {
	assert.equal(verdict(sample), ruleId, `still blocked by ${ruleId}: ${sample}`);
}

// The untouched rules behave exactly as before.
const untouched: Array<[string, string]> = [
	["sk-abcdefghijklmnopqrstuvwxyz0123", "openai-key"],
	["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "github-token"],
	["xoxb-abcdefghijklmnopqrstuvwxyz", "slack-token"],
	["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
	["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", "jwt-token"],
	[".env", "dot-env"],
	["./.env", "dot-env"],
	["~/.env", "dot-env"],
	["/app/.env", "dot-env"],
	['".env.local"', "dot-env"],
	['".env.production"', "dot-env"],
	["cat .env", "dot-env"],
	["~/.ssh/id_rsa", "id-rsa"],
	["certs/server.pem", "pem-file"],
];
for (const [sample, ruleId] of untouched) {
	assert.equal(verdict(sample), ruleId, `untouched rule ${ruleId} still fires: ${sample}`);
}
assert.equal(verdict(".env.example"), undefined, "dot-env still allows documentation templates");

// A rejected candidate does not hide a later real one in the same text.
assert.equal(
	verdict('access_token: response.access_token\nconst fallback = { access_token: "ya29.a0AfH6SMBx7Qk3n9vLw2Pq8rT5uY1zA4bC6dE8fG0h" };'),
	"secret-label-value",
	"a later credential is found after an identifier candidate",
);

console.log("content-policy value-shape tests passed");
