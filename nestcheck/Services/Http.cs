using System;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;

namespace PenguinMonitor.Services
{
    /// <summary>
    /// Creates HttpClients that connect over IPv4 only. Some networks give the device
    /// an IPv6 route that silently drops traffic; the default handler then times out
    /// instead of falling back to IPv4 (browsers fall back, so only the app fails).
    /// </summary>
    internal static class Http
    {
        internal static HttpClient CreateClient(TimeSpan timeout)
        {
            var handler = new SocketsHttpHandler
            {
                ConnectCallback = async (ctx, ct) =>
                {
                    var addresses = await Dns.GetHostAddressesAsync(ctx.DnsEndPoint.Host, AddressFamily.InterNetwork, ct);
                    var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                    try
                    {
                        await socket.ConnectAsync(addresses, ctx.DnsEndPoint.Port, ct);
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch
                    {
                        socket.Dispose();
                        throw;
                    }
                }
            };
            return new HttpClient(handler) { Timeout = timeout };
        }
    }
}
