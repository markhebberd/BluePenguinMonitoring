using Newtonsoft.Json;
using PenguinMonitor.Models;
using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;

namespace PenguinMonitor.Services
{
    /// <summary>
    /// HTTP client service for BoxTags REST API
    /// </summary>
    public class BoxTagApiService
    {
        private readonly HttpClient _httpClient;
        private readonly string _apiUrl;
        private readonly Func<string?> _tokenProvider;
        private readonly Func<int> _colonyProvider;

        public BoxTagApiService(string apiUrl, Func<string?> tokenProvider, Func<int> colonyProvider)
        {
            _apiUrl = apiUrl.TrimEnd('/');
            _tokenProvider = tokenProvider;
            _colonyProvider = colonyProvider;
            _httpClient = Http.CreateClient(TimeSpan.FromSeconds(30));
        }

        // Every request carries the colony the user is currently viewing (read live so a
        // colony switch is picked up); the server checks the token has access to it.
        private string Url(string? extraQuery = null)
        {
            var q = $"colony_id={_colonyProvider()}";
            if (!string.IsNullOrEmpty(extraQuery)) q += "&" + extraQuery;
            return $"{_apiUrl}?{q}";
        }

        // Box tags are authenticated with the logged-in user's session token (read
        // dynamically so login/refresh is always picked up). Reads accept it via
        // requireReadAuth + per-colony view; writes need requireAuth + colony edit.
        private HttpRequestMessage Request(HttpMethod method, string url, HttpContent? content = null)
        {
            var req = new HttpRequestMessage(method, url);
            var token = _tokenProvider();
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (content != null) req.Content = content;
            return req;
        }

        // No reads here. Box tags arrive on the snapshot feed with the locations they belong to —
        // pit_id, the stored fix and when it was read are columns on the location row — so this
        // client is write-only: save a tag, clear a tag.

        /// <summary>
        /// Create or update a box tag
        /// </summary>
        public async Task<bool> SaveBoxTagAsync(BoxTag boxTag)
        {
            try
            {
                var json = JsonConvert.SerializeObject(boxTag);
                var content = new StringContent(json, Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(Request(HttpMethod.Post, Url(), content));
                response.EnsureSuccessStatusCode();

                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"BoxTagApiService.SaveBoxTagAsync failed: {ex.Message}");
                throw;
            }
        }

        /// <summary>
        /// Delete a box tag
        /// </summary>
        public async Task<bool> DeleteBoxTagAsync(string boxId)
        {
            try
            {
                var response = await _httpClient.SendAsync(Request(HttpMethod.Delete, Url($"box_id={Uri.EscapeDataString(boxId)}")));

                // 404 is acceptable - tag already doesn't exist
                if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                {
                    return true;
                }

                response.EnsureSuccessStatusCode();
                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"BoxTagApiService.DeleteBoxTagAsync failed: {ex.Message}");
                throw;
            }
        }

    }
}
