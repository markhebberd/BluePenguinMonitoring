using System;
using System.Net.Http;

namespace PenguinMonitor.Services
{
    /// <summary>
    /// Central HttpClient factory. Was IPv4-only for v38.19–38.22 to work around a
    /// broken AAAA record on wildwatch.co.nz (fixed at Porkbun, Jul 2026); back to
    /// default dual-stack networking.
    /// </summary>
    internal static class Http
    {
        internal static HttpClient CreateClient(TimeSpan timeout)
        {
            return new HttpClient { Timeout = timeout };
        }
    }
}
