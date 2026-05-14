-keepattributes *Annotation*

# kotlinx-serialization
-keepclassmembers class kotlinx.serialization.json.** { *; }
-keep,includedescriptorclasses class nz.co.penguinmonitor.model.**$$serializer { *; }
-keepclassmembers class nz.co.penguinmonitor.model.** {
    *** Companion;
}
-keepclasseswithmembers class nz.co.penguinmonitor.model.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
