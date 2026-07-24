FROM php:8.3-apache

# The API needs pdo_mysql; the SPA needs mod_rewrite for client-side routes.
RUN docker-php-ext-install -j"$(nproc)" pdo_mysql \
 && a2enmod rewrite \
 && printf 'ServerName localhost\n' > /etc/apache2/conf-available/servername.conf \
 && a2enconf servername

COPY apache-site.conf /etc/apache2/sites-available/000-default.conf

# Production is UTC (config.php forces the session time_zone); match it here.
RUN printf 'date.timezone=UTC\nmemory_limit=256M\n' > /usr/local/etc/php/conf.d/wildwatch.ini
