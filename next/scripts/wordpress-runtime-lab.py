"""Disposable Linux VM only: validate the exported theme in real WordPress/PHP/MariaDB."""
import hashlib, json, os, pathlib, secrets, shutil, socket, subprocess, sys, tarfile, tempfile, time, urllib.request
if sys.platform != 'linux' or os.environ.get('IRONCREW_LOCAL_WP_LAB') != '1':
    raise SystemExit('Run only inside the explicitly isolated Linux lab with IRONCREW_LOCAL_WP_LAB=1')
archive = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve(); out.mkdir(parents=True, exist_ok=True)
root = pathlib.Path(tempfile.mkdtemp(prefix='ironcrew-wordpress-lab-'))
version = '7.0.4'; database = 'ic_wp_' + secrets.token_hex(4); password = secrets.token_hex(24)
server = None

def sql(statement):
    subprocess.run(['sudo', '-n', 'mariadb'], input=statement, text=True, check=True, capture_output=True)

def download(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'IronCrew-local-validation/1.0'}), timeout=60) as response:
        return response.read()

try:
    package = download(f'https://wordpress.org/wordpress-{version}.tar.gz')
    (root/'wordpress.tgz').write_bytes(package)
    with tarfile.open(root/'wordpress.tgz') as tar:
        tar.extractall(root, filter='data')
    wordpress = root/'wordpress'
    raw_checksums = download(f'https://api.wordpress.org/core/checksums/1.0/?version={version}&locale=en_US')
    checksums = json.loads(raw_checksums)['checksums']
    assert checksums
    verified = 0
    for relative, expected in checksums.items():
        target = wordpress/relative
        assert target.is_relative_to(wordpress) and '..' not in pathlib.PurePosixPath(relative).parts
        assert target.is_file(), relative
        assert hashlib.md5(target.read_bytes()).hexdigest() == expected, relative
        verified += 1
    staged = root/'theme'; staged.mkdir()
    with tarfile.open(archive) as tar:
        tar.extractall(staged, filter='data')
    theme = staged/'dist'/'ironcrew-customer-site'
    assert (theme/'templates'/'index.html').is_file()
    shutil.copytree(theme, wordpress/'wp-content'/'themes'/'ironcrew-customer-site')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    sql(f"CREATE DATABASE {database}; CREATE USER '{database}'@'localhost' IDENTIFIED BY '{password}'; GRANT ALL PRIVILEGES ON {database}.* TO '{database}'@'localhost';")
    settings={'DB_NAME':database,'DB_USER':database,'DB_PASSWORD':password,'DB_HOST':'localhost','DB_CHARSET':'utf8mb4','DB_COLLATE':'','WP_HOME':url,'WP_SITEURL':url}
    settings.update({key:secrets.token_hex(32) for key in ['AUTH_KEY','SECURE_AUTH_KEY','LOGGED_IN_KEY','NONCE_KEY','AUTH_SALT','SECURE_AUTH_SALT','LOGGED_IN_SALT','NONCE_SALT']})
    config='<?php\n'+''.join(f"define('{key}', '{value}');\n" for key,value in settings.items())
    config+="define('DISABLE_WP_CRON', true); define('AUTOMATIC_UPDATER_DISABLED', true); define('WP_HTTP_BLOCK_EXTERNAL', true); define('WP_DEBUG', true); define('WP_DEBUG_DISPLAY', false); define('WP_DEBUG_LOG', true); $table_prefix = 'wp_'; if (!defined('ABSPATH')) define('ABSPATH', __DIR__.'/'); require_once ABSPATH.'wp-settings.php';\n"
    (wordpress/'wp-config.php').write_text(config); (wordpress/'wp-config.php').chmod(0o600)
    installer=root/'install.php'
    installer.write_text("<?php\ndefine('WP_INSTALLING', true); require "+repr(str(wordpress/'wp-load.php'))+"; require_once ABSPATH.'wp-admin/includes/upgrade.php'; add_filter('pre_wp_mail', '__return_true'); $result=wp_install('IronCrew theme fixture','fixture_admin','fixture@example.invalid',false,'',bin2hex(random_bytes(24))); switch_theme('ironcrew-customer-site'); $theme=wp_get_theme(); if(!$theme->exists() || !wp_is_block_theme())throw new Exception('Block theme not active'); echo json_encode(['installed'=>is_array($result),'theme'=>$theme->get_stylesheet(),'wordpress'=>$wp_version,'blockTheme'=>wp_is_block_theme()]);\n")
    installed=subprocess.run(['php',str(installer)],capture_output=True,text=True,check=True)
    install_evidence=json.loads(installed.stdout); assert install_evidence['wordpress']==version
    log=open(root/'php-server.log','wb')
    server=subprocess.Popen(['php','-S',f'127.0.0.1:{port}','-t',str(wordpress)],stdout=log,stderr=log)
    for attempt in range(100):
        try:
            html=download(url+'/').decode(); break
        except OSError:
            if server.poll() is not None: raise RuntimeError('PHP server exited')
            time.sleep(0.1)
    else: raise RuntimeError('WordPress HTTP startup timed out')
    assert 'Isolated website fixture' in html
    assert 'Fatal error' not in html
    css=download(url+'/wp-content/themes/ironcrew-customer-site/style.css').decode()
    assert 'Theme Name: IronCrew Customer Site' in css
    rest=json.loads(download(url+'/index.php?rest_route=/'))
    assert rest['name']=='IronCrew theme fixture'
    (out/'wordpress-rendered.html').write_text(html)
    evidence={'passed':True,'testedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'wordpressVersion':version,'wordpressTarSha256':hashlib.sha256(package).hexdigest(),'officialFileChecksumsVerified':verified,'themeArchiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'phpVersion':subprocess.check_output(['php','-r','echo PHP_VERSION;'],text=True),'databaseVersion':subprocess.check_output(['sudo','-n','mariadb','--skip-column-names','-e','SELECT VERSION()'],text=True).strip(),'installation':install_evidence,'http':{'homepage':200,'themeCss':200,'restApi':200,'fixtureHeading':True},'externalMailDisabled':True,'cronAndExternalHttpDisabled':True,'productionDeployment':False}
    (out/'wordpress-runtime.json').write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps(evidence))
finally:
    if server:
        server.terminate(); server.wait(timeout=10)
    try: sql(f"DROP DATABASE IF EXISTS {database}; DROP USER IF EXISTS '{database}'@'localhost';")
    finally: shutil.rmtree(root)
