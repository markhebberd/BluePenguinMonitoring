<?php
/**
 * Nestcheck deep-link authentication.
 *
 * Flow:
 * 1. App opens this page in default browser
 * 2. User logs in (or is already logged in via session cookie)
 * 3. Server generates a token and redirects to nestcheck://auth?token=xxx&name=...&observer_id=...
 *
 * GET  /penguin-api/auth.php         - Show login form or redirect if already authenticated
 * POST /penguin-api/auth.php         - Handle login form submission
 */
require_once 'config.php';

$pdo = getDbConnection();
$error = '';

// Stateless by design: this link page never remembers a previous login, so opening it always
// asks for credentials. (An earlier version kept its own PHP session cookie and would re-auth
// as the last user who signed in on this browser — which is how "marian" got linked as "Mark".
// That browser session is separate from nestcheck's token, so logging out of the app never
// cleared it.) Also proactively drop any leftover session cookie from that old behaviour.
if (session_status() === PHP_SESSION_ACTIVE || isset($_COOKIE[session_name()])) {
    @session_start();
    $_SESSION = [];
    @session_destroy();
}

// Handle login form submission
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $email = trim($_POST['email'] ?? '');
    $password = $_POST['password'] ?? '';

    $stmt = $pdo->prepare("SELECT * FROM observers WHERE email = ?");
    $stmt->execute([$email]);
    $rows = $stmt->fetchAll();

    $observer = null;
    foreach ($rows as $row) {
        if (password_verify($password, $row['passphrase_hash'])) {
            $observer = $row;
            break;
        }
    }

    if ($observer) {
        redirectToApp($pdo, $observer);
        exit;
    } else {
        $error = 'Invalid email or password';
    }
}

function redirectToApp($pdo, $observer) {
    // Generate a 30-day session token
    $token = bin2hex(random_bytes(32));
    $expires = date('Y-m-d H:i:s', time() + 86400 * 30);
    $pdo->prepare("INSERT INTO sessions (token, observer_id, expires_at) VALUES (?, ?, ?)")
        ->execute([$token, $observer['observer_id'], $expires]);

    $name = urlencode($observer['observer_name']);
    $oid = $observer['observer_id'];
    $role = urlencode($observer['role'] ?? 'viewer');

    // Redirect to Nestcheck deep link
    $deepLink = "nestcheck://auth?token=$token&name=$name&observer_id=$oid&role=$role";
    header("Location: $deepLink");
    exit;
}

// Show login page
?>
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Link Nestcheck</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f5f7fa; color:#333; display:flex; justify-content:center; align-items:center; min-height:100vh; }
        .card { background:#fff; padding:2em; border-radius:12px; box-shadow:0 2px 12px rgba(0,0,0,0.1); width:100%; max-width:360px; }
        h1 { font-size:1.3em; margin-bottom:0.3em; }
        .subtitle { color:#888; font-size:0.9em; margin-bottom:1.5em; }
        label { display:block; font-size:0.85em; color:#666; margin-bottom:4px; margin-top:12px; }
        input[type=email], input[type=password] { width:100%; padding:10px; border:1px solid #ddd; border-radius:6px; font-size:1em; }
        input:focus { outline:none; border-color:#1a5276; }
        button { width:100%; padding:12px; background:#1a5276; color:#fff; border:none; border-radius:6px; font-size:1em; cursor:pointer; margin-top:1.5em; }
        button:hover { background:#154360; }
        .error { color:#F44336; font-size:0.85em; margin-top:8px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Link Nestcheck</h1>
        <p class="subtitle">Sign in with your Wildwatch account to connect the app.</p>
        <form method="POST">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required value="<?= htmlspecialchars($_POST['email'] ?? '') ?>">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>
            <?php if ($error): ?>
                <p class="error"><?= htmlspecialchars($error) ?></p>
            <?php endif; ?>
            <button type="submit">Sign in & link app</button>
        </form>
    </div>
</body>
</html>
