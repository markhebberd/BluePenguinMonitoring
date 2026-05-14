package nz.co.penguinmonitor.model

import kotlinx.datetime.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

@Serializable
data class AppSettings(
    @SerialName("AllBoxSetsString") val allBoxSetsString: String = "",
    @SerialName("BoxSetString") val boxSetString: String = "",
    @SerialName("IsBlueToothEnabled") val isBluetoothEnabled: Boolean = false,
    @SerialName("CurrentlyVisibleMonitor") val currentlyVisibleMonitor: Int = 0,
    @SerialName("ActiveSessionLocalTimeStamp") val activeSessionLocalTimeStamp: Instant? = null,
    @SerialName("ActiveSessionTimeStampActive") val activeSessionTimeStampActive: Boolean = false,
    @SerialName("ShowBoxTagDeleteButton") val showBoxTagDeleteButton: Boolean = false,
    // Breeding dates timeline
    @SerialName("ShowBreedingDatesTimeline") val showBreedingDatesTimeline: Boolean = false,
    @SerialName("ShowHatchingDatesInTimeline") val showHatchingDatesInTimeline: Boolean = true,
    @SerialName("ShowPGDatesInTimeline") val showPGDatesInTimeline: Boolean = true,
    @SerialName("ShowChippingDatesInTimeline") val showChippingDatesInTimeline: Boolean = true,
    @SerialName("ShowFledgingDatesInTimeline") val showFledgingDatesInTimeline: Boolean = true,
    // API config
    @SerialName("BoxTagsApiUrl") val boxTagsApiUrl: String = "",
    @SerialName("BoxTagsApiKey") val boxTagsApiKey: String = "",
    // Filter state - flattened to match C# JSON format
    @SerialName("ShowAllBoxesInMultiBoxView") val showAllBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowBoxesWithDataInMultiBoxView") val showBoxesWithDataInMultiBoxView: Boolean = false,
    @SerialName("ShowNoBoxesInMultiBoxView") val showNoBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowUnlikleyBoxesInMultiBoxView") val showUnlikleyBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowPotentialBoxesInMultiBoxView") val showPotentialBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowConfidentBoxesInMultiBoxView") val showConfidentBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowBreedingBoxesInMultiBoxView") val showBreedingBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowBoxesWithNotesInMultiboxView") val showBoxesWithNotesInMultiboxView: Boolean = false,
    @SerialName("ShowInterestingBoxesInMultiBoxView") val showInterestingBoxesInMultiBoxView: Boolean = false,
    @SerialName("ShowSingleEggBoxesInMultiboxView") val showSingleEggBoxesInMultiboxView: Boolean = false,
    @SerialName("ShowDoubleEggBoxesInMultiboxView") val showDoubleEggBoxesInMultiboxView: Boolean = false,
    @SerialName("ShowDCMBoxesInMultiboxView") val showDCMBoxesInMultiboxView: Boolean = false,
    @SerialName("ShowABNBoxesInMultiboxView") val showABNBoxesInMultiboxView: Boolean = false,
    @SerialName("HideBoxesWithDataInMultiBoxView") val hideBoxesWithDataInMultiBoxView: Boolean = false,
    @SerialName("HideDCMInMultiBoxView") val hideDCMInMultiBoxView: Boolean = false,
    @SerialName("HideABNInMultiBoxView") val hideABNInMultiBoxView: Boolean = false,
    @SerialName("HideNoBoxesInMultiBoxView") val hideNoBoxesInMultiBoxView: Boolean = false,
    @SerialName("HideUnlikelyBoxesInMultiBoxView") val hideUnlikelyBoxesInMultiBoxView: Boolean = false,
    @SerialName("HidePotentialBoxesInMultiBoxView") val hidePotentialBoxesInMultiBoxView: Boolean = false,
    @SerialName("HideConfidentBoxesInMultiBoxView") val hideConfidentBoxesInMultiBoxView: Boolean = false,
    @SerialName("HideBreedingBoxesInMultiBoxView") val hideBreedingBoxesInMultiBoxView: Boolean = false,
    @SerialName("HideBoxesWithNotesInMultiboxView") val hideBoxesWithNotesInMultiboxView: Boolean = false,
    @SerialName("HideInterestingBoxesInMultiBoxView") val hideInterestingBoxesInMultiBoxView: Boolean = false,
    @SerialName("HideSingleEggBoxesInMultiboxView") val hideSingleEggBoxesInMultiboxView: Boolean = false,
    @SerialName("HideDoubleEggBoxesInMultiboxView") val hideDoubleEggBoxesInMultiboxView: Boolean = false,
    @SerialName("HideBeforeCurrentInMultiBoxView") val hideBeforeCurrentInMultiBoxView: Boolean = false,
    @SerialName("ShowFiltersVisible") val showFiltersVisible: Boolean = false,
    @SerialName("HideFiltersVisible") val hideFiltersVisible: Boolean = false,
    @SerialName("ShowMultiboxFilterCard") val showMultiboxFilterCard: Boolean = false
) {
    val isBoxTagsApiConfigured: Boolean
        get() = boxTagsApiUrl.isNotBlank() && boxTagsApiKey.isNotBlank()
}
