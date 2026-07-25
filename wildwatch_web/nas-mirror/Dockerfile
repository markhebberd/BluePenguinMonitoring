# One container: Debian 13 + PHP 8.4 + MariaDB 11.8 — the same versions as the production
# VPS, so a dump that restores here restores there. Apache stands in for nginx+php-fpm; the
# API is ordinary PHP and doesn't care, and one process manager is enough for a mirror.
#
# Everything lives in this single image + one bind-mounted folder, so deleting the mirror is
# "remove the project, delete /volume1/wildwatch" — no leftover volumes, networks or packages.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      apache2 libapache2-mod-php8.4 php8.4-mysql php8.4-opcache \
      mariadb-server mariadb-client \
      ca-certificates curl \
 && a2enmod rewrite \
 && a2dismod -f mpm_event 2>/dev/null || true \
 && a2enmod mpm_prefork \
 && printf 'ServerName localhost\n' > /etc/apache2/conf-available/servername.conf \
 && a2enconf servername \
 && rm -rf /var/lib/apt/lists/*

COPY apache-site.conf /etc/apache2/sites-available/000-default.conf

# Production forces UTC per-session (config.php); match it here too.
RUN printf 'date.timezone=UTC\nmemory_limit=256M\n' > /etc/php/8.4/apache2/conf.d/99-wildwatch.ini

# MariaDB defaults assume a server, not a 2 GB NAS holding a 10 MB database.
RUN printf '[mysqld]\n\
innodb-buffer-pool-size = 64M\n\
performance-schema      = OFF\n\
max-connections         = 25\n\
key-buffer-size         = 8M\n\
tmp-table-size          = 16M\n\
max-heap-table-size     = 16M\n\
skip-name-resolve\n\
bind-address            = 127.0.0.1\n' > /etc/mysql/mariadb.conf.d/99-wildwatch.cnf

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
