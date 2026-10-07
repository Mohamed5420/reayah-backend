import type { IAddress } from '../../interfaces/IAddress';
import type { AreaDescription } from '../../services/location';
import type { Language } from '../../utils/i18n';
import { addressFullText } from '../../services/address/address-text';
import { localized } from './localize';

export const presentAddress = (a: IAddress, place: AreaDescription | undefined, lang: Language) => ({
  id: String(a._id),
  label: a.label,
  governorate: {
    id: String(a.governorateId),
    name: place ? localized(place.governorate.nameAr, place.governorate.nameEn, lang) : '',
  },
  area: { id: String(a.areaId), name: place ? localized(place.area.nameAr, place.area.nameEn, lang) : '' },
  street: a.street,
  building: a.building,
  floor: a.floor,
  apartment: a.apartment,
  landmark: a.landmark,
  notes: a.notes,
  is_default: a.isDefault,
  is_bookable: place?.bookable ?? false,
  full_text: addressFullText(a, place, lang),
});
